import * as R from 'ramda'
import { Sequelize, Transaction, Op, QueryTypes } from 'sequelize'
import { Timer } from 'timer-node'
import * as lmdb from 'lmdb'
import { nullable as MaybeNullable } from 'pratica'

import { SubredditsMasterListModel } from './entities/SubredditsMasterList'
import { firstRun } from './db-first-run'
import { dbLogger } from '../logging/logging'
import { UpdatesTrackerModel } from './entities/UpdatesTracker'
import { UserModel } from './entities/Users/Users'
import { PostModel } from './entities/Posts/Posts'
import { Post, PostWithComments } from './entities/Posts/Post'
import { createAndSyncSubredditTable, loadSubredditTableModels, TopPostsRowType } from './entities/SubredditTable'
import {
  getPostsPaginatedForAllSubsOfUser,
  getPostsPaginatedForSubreddit,
  getTopPostsPaginatedForAllSubsOfUser,
  getTopPostsPaginatedForSubreddit,
} from './posts/db-get-posts-paginated'
import { searchPosts, SearchLimitedPostType } from './posts/db-search-posts'
import { TableModelTypes } from './entities/entity-types'
import {
  getAdminSettings,
  getSingleAdminSetting,
  setAdminData,
  adminGetAnyTableDataPaginated,
  adminSearchAnyDBTable,
  adminListTablesInDB,
  getAllUsersDBDataForAdmin,
} from './db-admin'
import {
  createUser,
  deleteUser,
  findUser,
  getUserSettings,
  getSpecificUserSetting,
  getUserSubreddits,
  setUserSpecificSetting,
  batchAddUserSubreddits,
  addUserSubreddit,
  getAllUsersSubredditsBarOneUser,
  removeUserSubreddit,
  getAllSubreddits,
} from './db-user'
import {
  getSinglePostData,
  getAllPostIds,
  getPostIdsWithNoCommentsYetFetched,
  getPostsWithMediaStillToDownload,
  getCountOfAllPostsWithMediaStillToDownload,
  setMediaDownloadedTrueForPost,
  incrementPostMediaDownloadTry,
  batchRemovePosts,
  batchAddNewPosts,
  batchAddSubredditsPostIdReferences,
  batchClearSubredditsPostIdReferences,
} from './posts/db-posts'

import { CommentContainer } from './entities/Comments'
import { getEnvFilePath, getFileSize } from '../server/utils'

const sqliteDBPath = process.env['SQLITE_DBPATH'] || './roffline-sqlite.db'
const commentsDBPath = process.env['COMMENTS_DBPATH'] || './roffline-comments-lmdb.db'

type TransactionType = Transaction | null | undefined
type TopFilterType = 'day' | 'week' | 'month' | 'year' | 'all'

type SubsPostsIdDataType = {
  [subreddit: string]: TopPostsRowType[]
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
  logging: (msg): void => dbLogger.trace(msg),
  // logging: true,
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
  createUser,
  deleteUser,
  findUser,
  getUserSettings,
  getSpecificUserSetting,
  getUserSubreddits,
  setUserSpecificSetting,
  batchAddUserSubreddits,
  addUserSubreddit,
  getAllUsersSubredditsBarOneUser,
  removeUserSubreddit(userName: string, subreddit: string): Promise<void> {
    return removeUserSubreddit(sequelize, userName, subreddit)
  },
  getAllSubreddits,
  getAllUsersDBDataForAdmin,
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
  getPostsPaginatedForAllSubsOfUser(
    userName: string,
    page = 1,
    topFilter: null | TopFilterType = null
  ): Promise<{ count: number; rows: Post[] }> {
    return this.getUserSubreddits(userName).then(userSubs =>
      topFilter
        ? getTopPostsPaginatedForAllSubsOfUser(userSubs, page, topFilter)
        : getPostsPaginatedForAllSubsOfUser(userSubs, page)
    )
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
    userName: string,
    searchTerm: string,
    page = 1,
    fuzzySearch = false
  ): Promise<{ rows: SearchLimitedPostType[]; count: number }> {
    return searchPosts({ userName, sequelize, searchTerm, page, fuzzySearch })
  },
  getSinglePostData(postId: string): Promise<PostWithComments> {
    return getSinglePostData(this.getPostComments, postId)
  },
  getAllPostIds,
  getPostIdsWithNoCommentsYetFetched,
  getPostsWithMediaStillToDownload,
  getCountOfAllPostsWithMediaStillToDownload,
  setMediaDownloadedTrueForPost,
  incrementPostMediaDownloadTry,
  batchRemovePosts(postsToRemove: string[]): Promise<void> {
    return batchRemovePosts(commentsDB, postsToRemove)
  },
  batchAddNewPosts(postsToAdd: Post[]): Promise<void> {
    return batchAddNewPosts(sequelize, postsToAdd)
  },
  batchAddSubredditsPostIdReferences(subsPostsIdRefs: SubsPostsIdDataType): Promise<void> {
    return batchAddSubredditsPostIdReferences(sequelize, subsPostsIdRefs)
  },
  batchClearSubredditsPostIdReferences(subs: string[]): Promise<void> {
    return batchClearSubredditsPostIdReferences(sequelize, subs)
  },
  // eslint-disable-next-line max-lines-per-function
  async batchSaveComments(postsComments: { id: string; comments: string }[]): Promise<void> {
    const timer = new Timer()
    timer.start()

    const postIds = postsComments.map(({ id }) => id)

    await sequelize.transaction(transaction =>
      PostModel.update({ commentsDownloaded: true }, { transaction, where: { id: { [Op.in]: postIds } } })
    )

    await commentsDB.transactionAsync(() => {
      postsComments.forEach(({ id, comments }) => {
        commentsDB.put(id, comments)
      })
    })

    dbLogger.debug(
      `db.batchAddCommentsToPosts for ${postsComments.length} posts comments took ${timer.format(
        '[%s] seconds [%ms] ms'
      )} to complete`
    )

    timer.clear()
  },
  getPostComments(postId: string): Promise<CommentContainer[] | [] | null> {
    const maybePostCommentsAsString = MaybeNullable(commentsDB.get(postId))

    const uJSONParse = R.unary(JSON.parse)

    const tryParseJson = R.tryCatch(uJSONParse, R.always({}))

    // There's a alot of metadata cruft we need to skip to get to the comments data
    const getCommentsData = R.compose(R.pathOr([], [1, 'data', 'children']), tryParseJson)

    // Make it promise based. Confusing if one db is promise based and other is sync.
    return Promise.resolve(
      maybePostCommentsAsString.cata({
        Just: getCommentsData,
        Nothing: () => null,
      })
    )
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
    totalCommentsDBSizeInBytes: number
  }> {
    const commentsDBFilePath = getEnvFilePath(process.env['COMMENTS_DBPATH'])

    const getSQLiteDBSize = (transaction: Transaction): Promise<number> =>
      (
        sequelize.query(`SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size();`, {
          transaction,
          raw: true,
          type: QueryTypes.SELECT,
        }) as Promise<[{ size: number }]>
      ).then((result: [{ size: number }]): number => result[0].size)

    return sequelize
      .transaction(transaction =>
        Promise.all([
          SubredditsMasterListModel.count({ transaction }),
          PostModel.count({ transaction }),
          UserModel.count({ transaction }),
          getSQLiteDBSize(transaction),
          getFileSize(commentsDBFilePath),
        ])
      )
      .then(sizes => ({
        subsMasterListTableNumRows: sizes[0],
        postsTableNumRows: sizes[1],
        usersTableNumRows: sizes[2],
        totalDBsizeInBytes: sizes[3],
        totalCommentsDBSizeInBytes: sizes[4],
      }))
  },
}

// // eslint-disable-next-line import/first
// import { dev } from './db-dev'
// // eslint-disable-next-line import/first
//import { isDev } from '../server/utils'
// isDev && dev.init(db)

export { db }
