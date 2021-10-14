import { Post } from '../../db/entities/Posts/Post'
import { User } from '../../db/entities/Users/User'

type PostWithDownloadedFiles = Post & { downloadedFiles: string[] }

type PostWithPostContentAndDownloadedFiles = PostWithDownloadedFiles & { postContent: string }

type PostWithPostContentAndDownloadedFilesAndPrettyDate = PostWithPostContentAndDownloadedFiles & {
  prettyDateCreated: string
  prettyDateCreatedAgo: string
}

type WindowWithProps = {
  csrfToken: string
  userSettings: User[]
  posts: PostWithPostContentAndDownloadedFilesAndPrettyDate[]
} & Window

export { WindowWithProps }
