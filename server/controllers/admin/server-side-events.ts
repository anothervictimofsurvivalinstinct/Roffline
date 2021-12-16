import * as R from 'ramda'
import RA from 'ramda-adjunct'
import { match, __ } from 'ts-pattern'
import type { FastifyReply, FastifyRequest } from 'fastify'

import {
  adminMediaDownloadsViewerOrganiser,
  adminMediaDownloadsViewerOrganiserEmitter,
} from '../../../downloads/media/media-downloads-viewer-organiser'
import type { PostWithMediaDownloadInfo } from '../../../downloads/media/media-downloads-viewer-organiser'
import type { FrontendDownload } from '../../../frontend/js/admin/admin-downloads-viewer/admin-downloads-viewer'

type PostId = string

type DownloadsMap = Map<string, PostWithMediaDownloadInfo>

type SSEData =
  | FrontendDownload[]
  | {
      postId: PostId
      reason?: string
      err?: string
      downloadFileSize?: number
      downloadedBytes?: number
      downloadSpeed?: number
      downloadProgress?: number
    }
  | null

type SSE = { event: string; data: SSEData }

type TrimmedDownloadProps = Pick<
  PostWithMediaDownloadInfo,
  | 'id'
  | 'url'
  | 'downloadFailed'
  | 'downloadError'
  | 'downloadCancelled'
  | 'downloadCancellationReason'
  | 'downloadSkipped'
  | 'downloadSkippedReason'
  | 'downloadStarted'
  | 'downloadSucceeded'
  | 'downloadProgress'
  | 'downloadSpeed'
  | 'downloadedBytes'
  | 'downloadFileSize'
>

/*****
  Since we might be sending tens of thousands of downloads data to the frontend, its
  prolly a good idea to strip away object keys that have no data in them and reacreate
  them on the frontend.
*****/
const removePropsWithNoData = R.pickBy((val: FrontendDownload[keyof FrontendDownload]) =>
  match(val)
    .with(__.string, () => RA.isNonEmptyString(val))
    // @ts-expect-error this is fine, we know val will be a number here.
    .with(__.number, () => val > 0)
    .with(__.boolean, () => val !== false)
    .with(__.nullish, () => false)
    .otherwise(() => true)
)

const stringifyAnyErrors = (
  download: TrimmedDownloadProps
): { downloadError: string | undefined } & FrontendDownload => ({
  ...download,
  downloadError: RA.isError(download)
    ? download.downloadError?.toString()
    : (download.downloadError as string | undefined),
})

const convertDownloadsMapForFrontend = (downloads: DownloadsMap): FrontendDownload[] =>
  [...downloads.values()]
    .map(
      R.pick([
        'id',
        'url',
        'downloadFailed',
        'downloadError',
        'downloadCancelled',
        'downloadCancellationReason',
        'downloadSkipped',
        'downloadSkippedReason',
        'downloadStarted',
        'downloadSucceeded',
        'downloadProgress',
        'downloadSpeed',
        'downloadedBytes',
        'downloadFileSize',
      ])
    )
    .map(stringifyAnyErrors)
    .map(removePropsWithNoData) as FrontendDownload[]

const createSSEEvent = ({ event, data }: SSE): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

// eslint-disable-next-line max-lines-per-function
function SSEHandler(request: FastifyRequest, reply: FastifyReply): void {
  reply.raw.setHeader('Content-Type', 'text/event-stream')
  reply.raw.setHeader('Cache-Control', 'no-cache')
  reply.raw.setHeader('x-no-compression', 'true')
  reply.raw.setHeader('Connection', 'keep-alive')

  reply.raw.write(
    createSSEEvent({
      event: 'page-load',
      data: convertDownloadsMapForFrontend(adminMediaDownloadsViewerOrganiser.posts),
    })
  )

  const newDownloadBatchStarted = (downloads: DownloadsMap): void => {
    console.log('newDownloadBatchStarted called')
    reply.raw.write(
      createSSEEvent({
        event: 'new-download-batch-started',
        data: convertDownloadsMapForFrontend(downloads),
      })
    )
  }

  const downloadsCleared = (): void => {
    reply.raw.write(
      createSSEEvent({
        event: 'downloads-cleared',
        data: null,
      })
    )
  }

  const aDownloadStarted = (postId: string): void => {
    reply.raw.write(
      createSSEEvent({
        event: 'download-started',
        data: { postId },
      })
    )
  }

  const aDownloadFailed = (postId: string, err?: Error): void => {
    const error = err ? err.toString() : ''

    reply.raw.write(
      createSSEEvent({
        event: 'download-failed',
        data: { postId, err: error },
      })
    )
  }

  const aDownloadSucceeded = (postId: string): void => {
    reply.raw.write(
      createSSEEvent({
        event: 'download-succeeded',
        data: { postId },
      })
    )
  }

  const aDownloadCancelled = (postId: string, reason: string): void => {
    reply.raw.write(
      createSSEEvent({
        event: 'download-cancelled',
        data: { postId, reason },
      })
    )
  }

  const aDownloadSkipped = (postId: string, reason: string): void => {
    reply.raw.write(
      createSSEEvent({
        event: 'download-skipped',
        data: { postId, reason },
      })
    )
  }

  const progressOfADownload = (
    postId: string,
    downloadFileSize: number,
    downloadedBytes: number,
    downloadSpeed: number,
    downloadProgress: number
    // eslint-disable-next-line max-params
  ): void => {
    reply.raw.write(
      createSSEEvent({
        event: 'download-skipped',
        data: { postId, downloadFileSize, downloadedBytes, downloadSpeed, downloadProgress },
      })
    )
  }

  const downloadTryIncrementForDownload = (postId: string): void => {
    reply.raw.write(
      createSSEEvent({
        event: 'download-media-try-increment',
        data: { postId },
      })
    )
  }

  adminMediaDownloadsViewerOrganiserEmitter.on('new-download-batch-started', newDownloadBatchStarted)
  adminMediaDownloadsViewerOrganiserEmitter.on('downloads-cleared', downloadsCleared)
  adminMediaDownloadsViewerOrganiserEmitter.on('download-started', aDownloadStarted)
  adminMediaDownloadsViewerOrganiserEmitter.on('download-failed', aDownloadFailed)
  adminMediaDownloadsViewerOrganiserEmitter.on('download-succeeded', aDownloadSucceeded)
  adminMediaDownloadsViewerOrganiserEmitter.on('download-cancelled', aDownloadCancelled)
  adminMediaDownloadsViewerOrganiserEmitter.on('download-skipped', aDownloadSkipped)
  adminMediaDownloadsViewerOrganiserEmitter.on('download-progress', progressOfADownload)
  adminMediaDownloadsViewerOrganiserEmitter.on('download-media-try-increment', downloadTryIncrementForDownload)

  // https://github.com/fastify/fastify/issues/1352#issuecomment-490997485
  request.raw.on('close', () => {
    adminMediaDownloadsViewerOrganiserEmitter.removeListener(
      'new-download-batch-started',
      newDownloadBatchStarted
    )
    adminMediaDownloadsViewerOrganiserEmitter.removeListener('downloads-cleared', downloadsCleared)
    adminMediaDownloadsViewerOrganiserEmitter.removeListener('download-started', aDownloadStarted)
    adminMediaDownloadsViewerOrganiserEmitter.removeListener('download-failed', aDownloadFailed)
    adminMediaDownloadsViewerOrganiserEmitter.removeListener('download-succeeded', aDownloadSucceeded)
    adminMediaDownloadsViewerOrganiserEmitter.removeListener('download-cancelled', aDownloadCancelled)
    adminMediaDownloadsViewerOrganiserEmitter.removeListener('download-skipped', aDownloadSkipped)
    adminMediaDownloadsViewerOrganiserEmitter.removeListener('download-progress', progressOfADownload)
    adminMediaDownloadsViewerOrganiserEmitter.removeListener(
      'download-media-try-increment',
      downloadTryIncrementForDownload
    )
  })
}

export { SSEHandler }
