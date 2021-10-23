import { Post } from '../../db/entities/Posts/Post'
import { User } from '../../db/entities/Users/User'

type PostWithDownloadedFiles = Post & { downloadedFiles: string[] }

type FrontendPost = PostWithDownloadedFiles & {
  prettyDateCreated: string
  prettyDateCreatedAgo: string
}

type IndexPageWindowWithProps = {
  userSettings: User
  posts: FrontendPost[]
  totalResults: number
} & Window

type SettingsPageWindowWithProps = {
  csrfToken: string
  userSettings: User
} & Window

export { IndexPageWindowWithProps, SettingsPageWindowWithProps, FrontendPost }
