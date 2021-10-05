import * as R from 'ramda'
import { Sequelize, Transaction, Op } from 'sequelize'
import { match } from 'ts-pattern'
import { Timer } from 'timer-node'
import * as lmdb from 'lmdb'

import { SubredditsMasterListModel } from './entities/SubredditsMasterList'
import { firstRun } from './db-first-run'
import { noop, omitDuplicateSubs } from '../server/utils'
import { dbLogger, mainLogger } from '../logging/logging'
import { UpdatesTrackerModel } from './entities/UpdatesTracker'
import { User, UserModel } from './entities/Users'
import { Post, PostModel } from './entities/Posts'
import {
  createAndSyncSubredditTable,
  loadSubredditTableModels,
  removeSubredditTable,
  SubredditTable,
  subredditTablesMap,
} from './entities/SubredditTable'
import {
  getPostsPaginated,
  getPostsPaginatedForSubreddit,
  getTopPostsPaginated,
  getTopPostsPaginatedForSubreddit,
} from './db-get-posts-paginated'
import { searchPosts, SearchLimitedPostType } from './db-search-posts'
import { TableModelTypes } from './entities/entity-types'
import {
  getAdminSettings,
  getSingleAdminSetting,
  setAdminData,
  adminGetAnyTableDataPaginated,
  adminSearchAnyDBTable,
  adminListTablesInDB,
} from './db-admin'
import { StructuredComments } from './entities/Comments'

const sqliteDBPath = process.env['SQLITE_DBPATH'] || './roffline-sqlite.db'
const commentsDBPath = process.env['COMMENTS_DBPATH'] || './roffline-comments-lmdb.db'

type TransactionType = Transaction | null | undefined
type TopFilterType = 'day' | 'week' | 'month' | 'year' | 'all'
type SubsPostsIdDataType = {
  [key: string]: SubredditTable[]
}

/*****
  Notes:
    * Until this (https://github.com/sequelize/sequelize/issues/12575) is fixed, we have to map
      over results and use .get() to get raw objects instead of model instances
    * Gotta use getterMethods and setterMethods instead of regular get()/set() in classes because of
        this: https://github.com/sequelize/sequelize/issues/8953
*****/

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: sqliteDBPath,
  logging: (msg): void => mainLogger.trace(msg),
})

const commentsDB = lmdb.open({
  path: commentsDBPath,
  compression: true,
  encoding: 'string',
})

const db = {
  sequelize,
  init(): Promise<void> {
    return firstRun(sequelize).then(() => loadSubredditTableModels(sequelize))
  },
  async close(): Promise<void> {
    await sequelize.close()
    commentsDB.close()
  },
  getLastScheduledUpdateTime(): Promise<string> {
    return UpdatesTrackerModel.findByPk(1, { attributes: ['lastUpdateDateAsString'] }).then(
      item => item?.get('lastUpdateDateAsString') as string
    )
  },
  async setLastScheduledUpdateTime(date: string | Date): Promise<void> {
    await UpdatesTrackerModel.update({ lastUpdateDateAsString: date }, { where: { id: 1 } })
  },
  async createUser(userName: string): Promise<void> {
    await UserModel.create({ name: userName }, { ignoreDuplicates: true })
  },
  getUserSettings(userName: string): Promise<User> {
    return UserModel.findOne({ where: { name: userName } }).then(userAsModel => userAsModel?.get() as User)
  },
  getUserSpecificSetting(userName: string, settingName: keyof User): Promise<User[keyof User]> {
    return UserModel.findOne({ where: { name: userName }, attributes: [settingName] }).then(
      user => user?.get(settingName) as User[keyof User]
    )
  },
  getUserSubreddits(userName: string): Promise<User[keyof User]> {
    return this.getUserSpecificSetting(userName, 'subreddits')
  },
  async setUserSpecificSetting(
    userName: string,
    settingName: keyof User,
    settingValue: User[keyof User]
  ): Promise<void> {
    const updateDetails = {
      settingName,
      settingValIsArray: Array.isArray(settingValue),
    }

    await match(updateDetails)
      .with({ settingName: 'subreddits', settingValIsArray: false }, () =>
        db.addUserSubreddit(userName, settingValue as string)
      )
      .with({ settingName: 'subreddits', settingValIsArray: true }, () =>
        db.batchAddUserSubreddits(userName, settingValue as string[])
      )
      .otherwise(() => UserModel.update({ [settingName]: settingValue }, { where: { name: userName } }))
  },
  async batchAddUserSubreddits(
    userName: string,
    subreddits: string[],
    transaction: TransactionType = null
  ): Promise<void> {
    const userSubs = await db.getUserSubreddits(userName)

    await UserModel.update(
      { subreddits: omitDuplicateSubs(userSubs as string[], subreddits) },
      { where: { name: userName }, transaction }
    )
  },
  addUserSubreddit(userName: string, subreddit: string, transaction: TransactionType = null): Promise<void> {
    return db.batchAddUserSubreddits(userName, [subreddit], transaction)
  },
  getAllUsersSubredditsBarOneUser(userToOmit: string, transaction: TransactionType = null): Promise<string[]> {
    return UserModel.findAll({
      attributes: ['subreddits'],
      where: { name: { [Op.not]: userToOmit } },
      transaction,
    }).then((users): string[] =>
      users.flatMap(userModelSubsAttr => userModelSubsAttr.get('subreddits') as string[])
    )
  },
  // eslint-disable-next-line max-lines-per-function
  async removeUserSubreddit(userName: string, subreddit: string): Promise<void> {
    const subredditToRemove = subreddit.toLowerCase()

    const removeSubFromUser = async (userSubs: string[], transaction: Transaction): Promise<void> => {
      await UserModel.update(
        { subreddits: R.without([subredditToRemove], userSubs) },
        { where: { name: userName }, transaction }
      )
    }

    const noOtherUserHasSubreddit = (allUsersSubs: string[], subToRemove: string): boolean =>
      !allUsersSubs.includes(subToRemove)

    await sequelize
      .transaction(async transaction => {
        await this.getUserSubreddits(userName).then((userSubs: User[keyof User]) =>
          removeSubFromUser(userSubs as string[], transaction)
        )

        return this.getAllUsersSubredditsBarOneUser(userName, transaction)
      })
      .then(allUsersSubreddits =>
        noOtherUserHasSubreddit(allUsersSubreddits, subredditToRemove)
          ? removeSubredditTable(subredditToRemove)
          : noop()
      )
  },
  getAllSubreddits(): Promise<string[]> {
    return SubredditsMasterListModel.findAll({ attributes: ['subreddit'] }).then(subs =>
      subs.map(subModelAttr => subModelAttr.get('subreddit') as string)
    )
  },
  async batchAddSubredditsToMasterList(subreddits: string[], transaction: TransactionType = null): Promise<void> {
    const subs = subreddits.map(subreddit => ({ subreddit }))

    await SubredditsMasterListModel.bulkCreate(subs, {
      ignoreDuplicates: true,
      fields: ['subreddit'],
      transaction,
    })
  },
  async addSingleSubredditToMasterList(newSub: string, transaction: TransactionType = null): Promise<void> {
    await SubredditsMasterListModel.create(
      { subreddit: newSub },
      { ignoreDuplicates: true, fields: ['subreddit'], transaction }
    )
  },
  async addSubreddit(userName: string, newSub: string): Promise<void> {
    await sequelize.transaction(transaction =>
      Promise.all([
        db.addSingleSubredditToMasterList(newSub, transaction),
        db.addUserSubreddit(userName, newSub, transaction),
        createAndSyncSubredditTable(newSub, sequelize, transaction),
      ])
    )
  },
  async batchAddSubreddits(userName: string, subsToAdd: string[]): Promise<void> {
    await sequelize.transaction(transaction =>
      Promise.all([
        db.batchAddSubredditsToMasterList(subsToAdd, transaction),
        db.batchAddUserSubreddits(userName, subsToAdd, transaction),
        ...subsToAdd.map(sub => createAndSyncSubredditTable(sub, sequelize, transaction)),
      ])
    )
  },
  getSinglePostData(postId: string): Promise<Post> {
    return PostModel.findByPk(postId).then(post => post?.get() as Post)
  },
  getPostsPaginated(page = 1, topFilter: null | TopFilterType = null): Promise<{ count: number; rows: Post[] }> {
    return topFilter ? getTopPostsPaginated(page, topFilter) : getPostsPaginated(page)
  },
  getPostsPaginatedForSubreddit(
    subreddit: string,
    page = 1,
    topFilter: null | TopFilterType = null
  ): Promise<{ count: number; rows: Post[] }> {
    return topFilter
      ? getTopPostsPaginatedForSubreddit(subreddit, page, topFilter)
      : getPostsPaginatedForSubreddit(subreddit, page)
  },
  searchPosts(
    searchTerm: string,
    page = 1,
    fuzzySearch = false
  ): Promise<{ rows: SearchLimitedPostType[]; count: number }> {
    return searchPosts(sequelize, searchTerm, page, fuzzySearch)
  },
  getAllPostIds(): Promise<string[]> {
    return PostModel.findAll({ attributes: ['postId'] }).then(items =>
      items.map(item => item.get('postId') as string)
    )
  },
  getPostIdsWithNoCommentsYetFetched(): Promise<string[]> {
    return PostModel.findAll({ where: { commentsDownloaded: false }, attributes: ['postId'] }).then(items =>
      items.map(item => item.get('postId') as string)
    )
  },
  getPostsWithMediaStillToDownload(): Promise<Post[]> {
    return PostModel.findAll({ where: { media_has_been_downloaded: false }, attributes: ['postId'] }).then(
      items => items.map(item => item.get() as Post)
    )
  },
  getCountOfAllPostsWithMediaStillToDownload(): Promise<number> {
    return PostModel.count({ where: { media_has_been_downloaded: false }, attributes: ['postId'] })
  },
  async setMediaDownloadedTrueForPost(postId: string): Promise<void> {
    await PostModel.update({ media_has_been_downloaded: true }, { where: { postId } })
  },
  async incrementPostMediaDownloadTry(postId: string): Promise<void> {
    await PostModel.increment('mediaDownloadTries', { where: { postId } })
  },
  async batchRemovePosts(postsToRemove: string[]): Promise<void> {
    const timer = new Timer()
    timer.start()

    await PostModel.destroy({ where: { postId: { [Op.in]: postsToRemove } } })

    await commentsDB.transactionAsync(() => {
      postsToRemove.forEach(postId => {
        commentsDB.remove(postId)
      })
    })

    dbLogger.debug(
      `db.batchRemovePosts for ${postsToRemove.length} posts and their comments took ${timer.format(
        '[%s] seconds [%ms] ms'
      )} to complete`
    )

    timer.clear()
  },
  // eslint-disable-next-line max-lines-per-function
  async batchAddNewPosts(postsToAdd: Post[]): Promise<void> {
    // eslint-disable-next-line functional/no-conditional-statement
    if (R.isEmpty(postsToAdd)) return Promise.resolve()

    const timer = new Timer()
    timer.start()

    const postsInDB: string[] = await sequelize.transaction(transaction =>
      PostModel.findAll({ attributes: ['postId'], transaction }).then(items =>
        items.map(item => item.get('postId') as string)
      )
    )

    const numNewPostsSansExisting = R.differenceWith(
      (x: Post, postId: string) => x.postId === postId,
      postsToAdd,
      postsInDB
    ).length

    await PostModel.bulkCreate(postsToAdd, { ignoreDuplicates: true, validate: true })

    dbLogger.debug(
      `db.batchAddNewPosts for ${numNewPostsSansExisting} posts (${postsToAdd.length} total) took ${timer.format(
        '[%s] seconds [%ms] ms'
      )} to complete`
    )

    timer.clear()
  },
  // eslint-disable-next-line max-lines-per-function
  async batchSaveComments(postsComments: { postId: string; comments: string }[]): Promise<void> {
    const timer = new Timer()
    timer.start()

    await sequelize.transaction(async transaction =>
      Promise.all([
        postsComments.map(({ postId }) =>
          PostModel.update({ commentsDownloaded: true }, { transaction, where: { postId } })
        ),
      ])
    )

    await commentsDB.transactionAsync(() => {
      postsComments.forEach(({ postId, comments }) => {
        commentsDB.put(postId, comments)
      })
    })

    dbLogger.debug(
      `db.batchAddCommentsToPosts for ${postsComments.length} posts comments took ${timer.format(
        '[%s] seconds [%ms] ms'
      )} to complete`
    )

    timer.clear()
  },
  async batchAddSubredditsPostIdData(subsPostsIdData: SubsPostsIdDataType): Promise<void> {
    await sequelize.transaction(transaction =>
      Promise.all(
        Object.keys(subsPostsIdData).map(subreddit =>
          subredditTablesMap
            .get(subreddit.toLowerCase())
            ?.bulkCreate(subsPostsIdData[subreddit], { ignoreDuplicates: true, transaction })
        )
      )
    )
  },
  async batchClearSubredditsPostIdData(subs: string[]): Promise<void> {
    await sequelize.transaction(transaction =>
      Promise.all(subs.map(sub => subredditTablesMap.get(sub.toLowerCase())?.truncate({ transaction })))
    )
  },
  getPostComments(postId: string): Promise<StructuredComments> {
    const postCommentsAsString = commentsDB.get(postId) as string
    // Make it promise based. Confusing if one db is promise based and other is sync.
    return Promise.resolve(JSON.parse(postCommentsAsString) as StructuredComments)
  },
  getAdminSettings,
  getSingleAdminSetting,
  setAdminData,
  adminListTablesInDB(): Promise<{ name: string }[]> {
    return adminListTablesInDB(sequelize)
  },
  adminGetPaginatedTableData(tableName: string, page = 1): Promise<{ rows: TableModelTypes[]; count: number }> {
    return adminGetAnyTableDataPaginated(sequelize, tableName, page)
  },
  adminSearchDBTable(
    tableName: string,
    searchTerm: string,
    page = 1
  ): Promise<{ rows: TableModelTypes[]; count: number }> {
    return adminSearchAnyDBTable(sequelize, tableName, searchTerm, page)
  },
  // eslint-disable-next-line max-lines-per-function
  getDBStats(): Promise<{
    subsMasterListTableNumRows: number
    postsTableNumRows: number
    usersTableNumRows: number
    totalDBsizeInBytes: number
  }> {
    return sequelize
      .transaction(transaction =>
        Promise.all([
          SubredditsMasterListModel.count({ transaction }),
          PostModel.count({ transaction }),
          UserModel.count({ transaction }),
          // DB size
          (
            sequelize.query(
              `SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size();`,
              {
                transaction,
              }
            ) as Promise<[[{ size: number }], unknown]>
          ).then((result: [[{ size: number }], unknown]): number => result[0][0].size),
        ])
      )
      .then(sizes => ({
        subsMasterListTableNumRows: sizes[0],
        postsTableNumRows: sizes[1],
        usersTableNumRows: sizes[2],
        totalDBsizeInBytes: sizes[3],
      }))
  },
}

export { db }

setTimeout(() => {
  // Promise.all([
  //   db.createUser('Kermit'),
  //   db.createUser('Kevin'),
  //   db.createUser('Alex'),
  //   db.createUser('Miss-Piggy'),
  // ])
  //   .then(() =>
  //     Promise.all([
  //       db.batchAddUserSubreddits('Kermit', ['aww', 'cats', 'dogs', 'bikes', 'cars', 'planes']),
  //       db.batchAddUserSubreddits('Kevin', ['cats', 'dogs', 'television']),
  //       db.batchAddUserSubreddits('Alex', ['aww', 'cats', 'dogs', 'bikes', 'tables']),
  //       db.batchAddUserSubreddits('Miss-Piggy', ['phones', 'chair', 'seats']),
  //     ])
  //   )
  // UserModel.update({ hideStickiedPosts: false }, { where: { name: 'Merp' } })
  db.setUserSpecificSetting('Merp', 'hideStickiedPosts', true)
    // db.getAdminSettings()
    //   .then(result => console.log(result))
    //   .then(() => db.setAdminData('downloadComments', true))
    //   .then(() => db.getAdminSettings())
    // db.removeUserSubreddit('Kermit', 'cats')
    .then(result => console.log(result))
    // .then(() => db.getAllUsersSubredditsBarOneUser('Miss-Piggy'))
    // //   // db.getLastScheduledUpdateTime()
    // .then(result => console.log(result))
    //   //   .then(() => db.setLastScheduledUpdateTime(new Date()))
    //   .then(() => db.getUserSubreddits('Merp'))
    //   .then(result => console.log(result))
    .then(() => console.log('finished'))
    .catch(err => console.error(err))
}, 2000) // eslint-disable-line @typescript-eslint/no-magic-numbers
