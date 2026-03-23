import axios from 'axios'
import { inflateRawSync } from 'node:zlib'
import { TextSplitter } from '@langchain/textsplitters'
import { getFileFromStorage, handleEscapeCharacters, INodeOutputsValue } from '../../../src'
import { ICommonObject, IDocument, INode, INodeData, INodeParams } from '../../../src/Interface'

type MinerUMode = 'flash' | 'precision'
type InputMode = 'url' | 'file'
type PrecisionModel = 'vlm' | 'pipeline' | 'html'

interface MinerUTaskResult {
    markdown: string
    source: string
    page?: number
    filename?: string
}

interface SourceTask {
    source: string
    fileBuffer?: Buffer
    pageRange?: string
    page?: number
}

interface UploadFile {
    fileName: string
    buffer: Buffer
}

interface MinerUCommonConfig {
    mode: MinerUMode
    language: string
    pageRange?: string
    timeoutSeconds: number
}

interface MinerUPrecisionConfig extends MinerUCommonConfig {
    mode: 'precision'
    token: string
    model: PrecisionModel
    ocr: boolean
    formula: boolean
    table: boolean
}

interface MinerUFlashConfig extends MinerUCommonConfig {
    mode: 'flash'
}

type MinerUConfig = MinerUPrecisionConfig | MinerUFlashConfig

const DEFAULT_SOURCE_HEADER = process.env.MINERU_SOURCE_HEADER || 'Flowise'
const DEFAULT_TIMEOUT_SECONDS = 300

const DEFAULT_FLASH_BASE_URL = process.env.MINERU_FLASH_BASE_URL || 'https://mineru.net/api/v1/agent'
const DEFAULT_ACCURATE_BASE_URL = process.env.MINERU_API_BASE_URL || 'https://mineru.net/api/v4'
const DEFAULT_MINERU_TOKEN = process.env.MINERU_TOKEN || ''

const SUPPORTED_FILE_TYPES = '.pdf,.png,.jpg,.jpeg,.jp2,.webp,.gif,.bmp,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.htm,.html'
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'jp2', 'webp', 'gif', 'bmp']
const FLASH_ALLOWED_EXTENSIONS = ['pdf', ...IMAGE_EXTENSIONS, 'docx', 'pptx', 'xls', 'xlsx']
const PRECISION_ALLOWED_EXTENSIONS = ['pdf', ...IMAGE_EXTENSIONS, 'doc', 'docx', 'ppt', 'pptx', 'htm', 'html']
const FLASH_ALLOWED_FORMATS_TEXT = '.pdf, images, .DOCX, .PPTX, .XLS, .XLSX'
const PRECISION_ALLOWED_FORMATS_TEXT = '.pdf, images, .DOC, .DOCX, .PPT, .PPTX, .html'

const POLL_MIN_INTERVAL_MS = 2000
const POLL_MAX_INTERVAL_MS = 30000

const MIME_EXTENSION_MAP: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/html': 'html'
}

class MinerU_DocumentLoaders implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs: INodeParams[]
    outputs: INodeOutputsValue[]

    constructor() {
        this.label = 'MinerU Document Loader'
        this.name = 'mineruDocumentLoader'
        this.version = 2.0
        this.type = 'Document'
        this.icon = 'mineru.svg'
        this.category = 'Document Loaders'
        this.description = 'Load and parse documents with MinerU flash/precision modes'
        this.baseClasses = [this.type]
        this.inputs = [
            {
                label: 'Text Splitter',
                name: 'textSplitter',
                type: 'TextSplitter',
                optional: true
            },
            {
                label: 'Mode',
                name: 'mode',
                type: 'options',
                description:
                    'Flash mode is token-free. Precision mode requires MinerU token. See <a href="https://mineru.net/apiManage/docs" target="_blank" rel="noopener noreferrer">API docs</a>.',
                options: [
                    {
                        label: 'Flash (No Token)',
                        name: 'flash'
                    },
                    {
                        label: 'Precision (Token Required)',
                        name: 'precision'
                    }
                ],
                default: 'flash'
            },
            {
                label: 'Input Mode',
                name: 'inputMode',
                type: 'options',
                options: [
                    {
                        label: 'URL',
                        name: 'url'
                    },
                    {
                        label: 'File Upload',
                        name: 'file'
                    }
                ],
                default: 'file'
            },
            {
                label: 'File URLs',
                name: 'fileUrls',
                type: 'string',
                rows: 4,
                description: 'One URL per line, or separated by commas.',
                placeholder: 'https://example.com/a.pdf,https://example.com/b.pdf',
                show: {
                    inputMode: ['url']
                }
            },
            {
                label: 'Upload Files',
                name: 'fileUpload',
                type: 'file',
                fileType: SUPPORTED_FILE_TYPES,
                show: {
                    inputMode: ['file']
                }
            },
            {
                label: 'MinerU Token',
                name: 'token',
                type: 'password',
                description:
                    'Required in precision mode. Apply token at <a href="https://mineru.net/apiManage/token" target="_blank" rel="noopener noreferrer">token page</a>. Full API docs: <a href="https://mineru.net/apiManage/docs" target="_blank" rel="noopener noreferrer">mineru.net/apiManage/docs</a>. If empty, fallback to MINERU_TOKEN env.',
                optional: true,
                additionalParams: true,
                show: {
                    mode: ['precision']
                }
            },
            {
                label: 'Precision Model',
                name: 'model',
                type: 'options',
                options: [
                    {
                        label: 'VLM',
                        name: 'vlm'
                    },
                    {
                        label: 'Pipeline',
                        name: 'pipeline'
                    },
                    {
                        label: 'HTML',
                        name: 'html'
                    }
                ],
                default: 'pipeline',
                additionalParams: true,
                show: {
                    mode: ['precision']
                }
            },
            {
                label: 'OCR',
                name: 'ocr',
                type: 'boolean',
                default: false,
                optional: true,
                additionalParams: true,
                show: {
                    mode: ['precision']
                }
            },
            {
                label: 'Formula',
                name: 'formula',
                type: 'boolean',
                default: true,
                optional: true,
                additionalParams: true,
                show: {
                    mode: ['precision']
                }
            },
            {
                label: 'Table',
                name: 'table',
                type: 'boolean',
                default: true,
                optional: true,
                additionalParams: true,
                show: {
                    mode: ['precision']
                }
            },
            {
                label: 'Language',
                name: 'language',
                type: 'string',
                description:
                    'OCR language hint. Default: ch. Common values: ch, en. Full list in <a href="https://mineru.net/apiManage/docs" target="_blank" rel="noopener noreferrer">MinerU docs</a>.',
                placeholder: 'ch',
                optional: true
            },
            {
                label: 'Page Range',
                name: 'pageRange',
                type: 'string',
                description: 'PDF only. Examples: 1-10, 3, 1-5,8. Leave empty to process all pages.',
                placeholder: '1-10',
                optional: true
            },
            {
                label: 'Split Pages',
                name: 'splitPages',
                type: 'boolean',
                description: 'Create one document per page for PDF sources. Requires Page Range in this Flowise node.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Timeout (Seconds)',
                name: 'timeoutSeconds',
                type: 'number',
                default: DEFAULT_TIMEOUT_SECONDS,
                description: 'Maximum seconds to wait for each extraction task.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Additional Metadata',
                name: 'metadata',
                type: 'json',
                description: 'Additional metadata to be added to the extracted documents',
                optional: true,
                additionalParams: true
            }
        ]
        this.outputs = [
            {
                label: 'Document',
                name: 'document',
                description: 'Array of document objects containing metadata and pageContent',
                baseClasses: [...this.baseClasses, 'json']
            },
            {
                label: 'Text',
                name: 'text',
                description: 'Concatenated string from pageContent of documents',
                baseClasses: ['string', 'json']
            }
        ]
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const textSplitter = nodeData.inputs?.textSplitter as TextSplitter
        const metadata = nodeData.inputs?.metadata
        const output = nodeData.outputs?.output as string

        const inputMode = ((nodeData.inputs?.inputMode as InputMode) || 'file') as InputMode
        const mode = this.resolveMode(nodeData.inputs?.mode as string)
        const language = ((nodeData.inputs?.language as string) || 'ch').trim()
        const pageRange = ((nodeData.inputs?.pageRange as string) || '').trim()
        const splitPages = this.asBoolean(nodeData.inputs?.splitPages, false)
        const timeoutSeconds = this.resolveTimeoutSeconds(nodeData.inputs?.timeoutSeconds)

        const baseConfig: MinerUCommonConfig = {
            mode,
            language: language || 'ch',
            pageRange: pageRange || undefined,
            timeoutSeconds
        }

        const config: MinerUConfig = this.buildConfig(nodeData, baseConfig)

        const tasks =
            inputMode === 'file'
                ? await this.buildFileTasks(nodeData, options, mode, pageRange, splitPages)
                : this.buildUrlTasks(nodeData, mode, pageRange, splitPages)

        const results: MinerUTaskResult[] = []
        for (const task of tasks) {
            const result = await this.runTask(task, config)
            results.push(result)
        }

        let docs: IDocument[] = results
            .filter((r) => r.markdown)
            .map((r) => ({
                pageContent: r.markdown,
                metadata: {
                    source: r.source,
                    loader: 'mineru',
                    parser: 'mineru',
                    output_format: 'markdown',
                    mode,
                    language: config.language,
                    pages: r.page !== undefined ? String(r.page) : config.pageRange || null,
                    split_pages: splitPages && r.page !== undefined,
                    ...(mode === 'precision' ? { model: this.resolveModelLabel(nodeData) } : {}),
                    ...(r.filename ? { filename: r.filename } : {}),
                    ...(r.page !== undefined ? { page: r.page, page_source: r.source } : {})
                }
            }))

        if (textSplitter) {
            docs = await textSplitter.splitDocuments(docs)
        }

        if (metadata) {
            const parsedMetadata = typeof metadata === 'object' ? metadata : JSON.parse(metadata)
            docs = docs.map((doc) => ({
                ...doc,
                metadata: { ...doc.metadata, ...parsedMetadata }
            }))
        }

        if (output === 'document') {
            return docs
        } else {
            let finaltext = ''
            for (const doc of docs) {
                finaltext += `${doc.pageContent}\n`
            }
            return handleEscapeCharacters(finaltext, false)
        }
    }

    private buildConfig(nodeData: INodeData, baseConfig: MinerUCommonConfig): MinerUConfig {
        if (baseConfig.mode === 'flash') {
            return {
                ...baseConfig,
                mode: 'flash'
            }
        }

        const tokenInput = ((nodeData.inputs?.token as string) || '').trim()
        const token = tokenInput || DEFAULT_MINERU_TOKEN
        if (!token) {
            throw new Error('MinerU precision mode requires token. Set node token or MINERU_TOKEN env.')
        }

        const inputModel = (nodeData.inputs?.model as string) || (nodeData.inputs?.accurateModel as string) || 'pipeline'
        const model = this.resolveModelInput(inputModel)
        const ocr = this.asBoolean(nodeData.inputs?.ocr, false)
        const formula = this.asBoolean(nodeData.inputs?.formula, true)
        const table = this.asBoolean(nodeData.inputs?.table, true)

        return {
            ...baseConfig,
            mode: 'precision',
            token,
            model,
            ocr,
            formula,
            table
        }
    }

    private buildUrlTasks(nodeData: INodeData, mode: MinerUMode, pageRange: string, splitPages: boolean): SourceTask[] {
        const fileUrls = nodeData.inputs?.fileUrls as string
        if (!fileUrls) throw new Error('File URLs are required in URL mode')

        const urls = fileUrls
            .split(/[\n,]/)
            .map((u: string) => u.trim())
            .filter(Boolean)

        if (urls.length === 0) throw new Error('No valid URLs provided')

        const tasks: SourceTask[] = []
        for (const url of urls) {
            this.validateSourceTypeByMode(url, mode)
            tasks.push(...this.expandTasksByPage(url, pageRange, splitPages))
        }
        return tasks
    }

    private async buildFileTasks(
        nodeData: INodeData,
        options: ICommonObject,
        mode: MinerUMode,
        pageRange: string,
        splitPages: boolean
    ): Promise<SourceTask[]> {
        const uploadFiles = await this.resolveUploadFiles(nodeData, options)
        const tasks: SourceTask[] = []

        for (const file of uploadFiles) {
            this.validateSourceTypeByMode(file.fileName, mode)
            if (!splitPages || !this.looksLikePdf(file.fileName)) {
                tasks.push({
                    source: file.fileName,
                    fileBuffer: file.buffer,
                    pageRange: pageRange || undefined
                })
                continue
            }

            if (!pageRange) {
                throw new Error('Split Pages is enabled, but Page Range is empty. Please provide Page Range in this node.')
            }

            const pages = this.parsePageRange(pageRange)
            for (const page of pages) {
                tasks.push({
                    source: file.fileName,
                    fileBuffer: file.buffer,
                    pageRange: String(page),
                    page
                })
            }
        }

        return tasks
    }

    private expandTasksByPage(source: string, pageRange: string, splitPages: boolean): SourceTask[] {
        if (!splitPages || !this.looksLikePdf(source)) {
            return [{ source, pageRange: pageRange || undefined }]
        }

        if (!pageRange) {
            throw new Error('Split Pages is enabled, but Page Range is empty. Please provide Page Range in this node.')
        }

        const pages = this.parsePageRange(pageRange)
        return pages.map((page) => ({
            source,
            pageRange: String(page),
            page
        }))
    }

    private async resolveUploadFiles(nodeData: INodeData, options: ICommonObject): Promise<UploadFile[]> {
        const fileUploadValue = nodeData.inputs?.fileUpload as string
        if (!fileUploadValue) throw new Error('File upload is required in File Upload mode')

        const result: UploadFile[] = []
        if (fileUploadValue.startsWith('FILE-STORAGE::')) {
            const raw = fileUploadValue.replace('FILE-STORAGE::', '')
            const fileNames = raw.startsWith('[') && raw.endsWith(']') ? (JSON.parse(raw) as string[]) : [raw]
            const orgId = options.orgId
            const chatflowid = options.chatflowid

            for (const fileName of fileNames) {
                if (!fileName) continue
                const fileData = await getFileFromStorage(fileName, orgId, chatflowid)
                result.push({
                    fileName,
                    buffer: Buffer.isBuffer(fileData) ? fileData : Buffer.from(fileData)
                })
            }
            return result
        }

        const rawFiles =
            fileUploadValue.startsWith('[') && fileUploadValue.endsWith(']') ? (JSON.parse(fileUploadValue) as string[]) : [fileUploadValue]
        for (let i = 0; i < rawFiles.length; i += 1) {
            const rawFile = rawFiles[i]
            if (!rawFile) continue
            result.push(this.decodeInlineUpload(rawFile, i))
        }

        return result
    }

    private decodeInlineUpload(rawFile: string, index: number): UploadFile {
        const filenameMatch = rawFile.match(/,filename:([^,]+)$/)
        const fileNameFromPayload = filenameMatch?.[1]?.trim()
        const contentPart = filenameMatch ? rawFile.slice(0, filenameMatch.index) : rawFile

        const commaIndex = contentPart.indexOf(',')
        if (commaIndex < 0) {
            throw new Error('Invalid uploaded file payload format')
        }

        const base64Payload = contentPart.slice(commaIndex + 1)
        const buffer = Buffer.from(base64Payload, 'base64')

        const mimeMatch = contentPart.match(/^data:([^;]+);base64,/i)
        const ext = mimeMatch?.[1] ? MIME_EXTENSION_MAP[mimeMatch[1].toLowerCase()] || 'bin' : 'bin'
        const guessedName = fileNameFromPayload || `upload_${Date.now()}_${index}.${ext}`

        return {
            fileName: guessedName,
            buffer
        }
    }

    private async runTask(task: SourceTask, config: MinerUConfig): Promise<MinerUTaskResult> {
        this.validateSourceTypeByMode(task.source, config.mode)

        if (task.fileBuffer && config.mode === 'flash') {
            return this.submitFastFileTask(task, config)
        }
        if (task.fileBuffer && config.mode === 'precision') {
            return this.submitAccurateFileTask(task, config)
        }

        if (config.mode === 'flash') {
            return this.submitFastUrlTask(task, config)
        }

        if (!this.looksLikeUrl(task.source)) {
            throw new Error(`Invalid URL source: ${task.source}`)
        }
        return this.submitAccurateUrlTask(task, config)
    }

    private async submitFastUrlTask(task: SourceTask, config: MinerUFlashConfig): Promise<MinerUTaskResult> {
        const payload: Record<string, string> = {
            url: task.source,
            language: config.language
        }
        if (task.pageRange) {
            payload.page_range = task.pageRange
        }

        const resp = await axios.post(`${DEFAULT_FLASH_BASE_URL}/parse/url`, payload, {
            headers: this.buildHeaders(),
            timeout: 30000
        })

        const taskId = this.getDataOrThrow(resp.data, `MinerU flash submit failed for ${task.source}`).task_id as string
        return this.pollFastAndDownload(taskId, task, config.timeoutSeconds)
    }

    private async submitFastFileTask(task: SourceTask, config: MinerUFlashConfig): Promise<MinerUTaskResult> {
        const fileName = task.source
        if (!task.fileBuffer) {
            throw new Error(`Missing file buffer for source: ${fileName}`)
        }

        const payload: Record<string, string> = {
            file_name: this.basename(fileName),
            language: config.language
        }
        if (task.pageRange) {
            payload.page_range = task.pageRange
        }

        const resp = await axios.post(`${DEFAULT_FLASH_BASE_URL}/parse/file`, payload, {
            headers: this.buildHeaders(),
            timeout: 30000
        })

        const data = this.getDataOrThrow(resp.data, `MinerU flash file submit failed for ${fileName}`)
        const taskId = data.task_id as string
        const fileUrl = data.file_url as string
        if (!fileUrl) throw new Error(`MinerU flash file upload URL missing for ${fileName}`)

        await axios.put(fileUrl, task.fileBuffer, {
            headers: { 'Content-Type': '' },
            timeout: 120000,
            transformRequest: [(body: Buffer) => body],
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        })

        return this.pollFastAndDownload(taskId, task, config.timeoutSeconds)
    }

    private async pollFastAndDownload(taskId: string, task: SourceTask, timeoutSeconds: number): Promise<MinerUTaskResult> {
        const deadline = Date.now() + timeoutSeconds * 1000
        let interval = POLL_MIN_INTERVAL_MS

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const resp = await axios.get(`${DEFAULT_FLASH_BASE_URL}/parse/${taskId}`, {
                headers: this.buildHeaders(),
                timeout: 30000
            })

            const data = this.getDataOrThrow(resp.data, `MinerU flash polling failed for ${task.source}`)
            const state = (data.state as string) || 'unknown'

            if (state === 'done') {
                const markdownUrl = data.markdown_url as string
                if (!markdownUrl) throw new Error(`MinerU flash mode markdown_url missing for ${task.source}`)
                const mdResp = await axios.get(markdownUrl, { timeout: 120000 })
                return {
                    markdown: mdResp.data as string,
                    source: task.source,
                    page: task.page,
                    filename: data.file_name as string
                }
            }

            if (state === 'failed') {
                throw new Error(`MinerU flash mode failed for ${task.source}: ${data.err_msg || 'unknown'} (code: ${data.err_code || '?'})`)
            }

            if (Date.now() > deadline) {
                throw new Error(`MinerU flash polling timeout for ${task.source} (task_id: ${taskId})`)
            }

            await this.sleep(interval)
            interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS)
        }
    }

    private async submitAccurateUrlTask(task: SourceTask, config: MinerUPrecisionConfig): Promise<MinerUTaskResult> {
        const payload: Record<string, unknown> = {
            url: task.source,
            ...this.buildAccurateOptions(config, task.pageRange)
        }

        const resp = await axios.post(`${DEFAULT_ACCURATE_BASE_URL}/extract/task`, payload, {
            headers: this.buildHeaders(config.token),
            timeout: 30000
        })

        const taskId = this.getDataOrThrow(resp.data, `MinerU precision submit failed for ${task.source}`).task_id as string
        return this.pollAccurateTaskAndDownload(taskId, task, config.timeoutSeconds, config.token)
    }

    private async submitAccurateFileTask(task: SourceTask, config: MinerUPrecisionConfig): Promise<MinerUTaskResult> {
        const fileName = task.source
        if (!task.fileBuffer) {
            throw new Error(`Missing file buffer for source: ${fileName}`)
        }
        const payload: Record<string, unknown> = {
            files: [{ name: this.basename(fileName) }],
            ...this.buildAccurateOptions(config, task.pageRange)
        }

        const resp = await axios.post(`${DEFAULT_ACCURATE_BASE_URL}/file-urls/batch`, payload, {
            headers: this.buildHeaders(config.token),
            timeout: 30000
        })

        const data = this.getDataOrThrow(resp.data, `MinerU precision file submit failed for ${fileName}`)
        const batchId = data.batch_id as string
        const fileUrls = Array.isArray(data.file_urls) ? (data.file_urls as string[]) : []
        const uploadUrl = fileUrls[0]

        if (!batchId) {
            throw new Error(`MinerU precision mode batch_id missing for ${fileName}`)
        }
        if (!uploadUrl) {
            throw new Error(`MinerU precision mode upload URL missing for ${fileName}`)
        }

        await axios.put(uploadUrl, task.fileBuffer, {
            headers: { 'Content-Type': '' },
            timeout: 120000,
            transformRequest: [(body: Buffer) => body],
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        })

        return this.pollAccurateBatchAndDownload(batchId, task, config.timeoutSeconds, config.token)
    }

    private async pollAccurateTaskAndDownload(
        taskId: string,
        task: SourceTask,
        timeoutSeconds: number,
        token: string
    ): Promise<MinerUTaskResult> {
        const deadline = Date.now() + timeoutSeconds * 1000
        let interval = POLL_MIN_INTERVAL_MS

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const resp = await axios.get(`${DEFAULT_ACCURATE_BASE_URL}/extract/task/${taskId}`, {
                headers: this.buildHeaders(token),
                timeout: 30000
            })

            const data = this.getDataOrThrow(resp.data, `MinerU precision polling failed for ${task.source}`)
            const state = (data.state as string) || 'unknown'

            if (state === 'done') {
                const zipUrl = data.full_zip_url as string
                if (!zipUrl) throw new Error(`MinerU precision mode full_zip_url missing for ${task.source}`)
                const markdown = await this.downloadAccurateMarkdown(zipUrl, task.source)
                return {
                    markdown,
                    source: task.source,
                    page: task.page,
                    filename: (data.file_name as string) || this.basename(task.source)
                }
            }

            if (state === 'failed') {
                throw new Error(
                    `MinerU precision mode failed for ${task.source}: ${data.err_msg || 'unknown'} (code: ${data.err_code || '?'})`
                )
            }

            if (Date.now() > deadline) {
                throw new Error(`MinerU precision mode timeout for ${task.source} (task_id: ${taskId})`)
            }

            await this.sleep(interval)
            interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS)
        }
    }

    private async pollAccurateBatchAndDownload(
        batchId: string,
        task: SourceTask,
        timeoutSeconds: number,
        token: string
    ): Promise<MinerUTaskResult> {
        const deadline = Date.now() + timeoutSeconds * 1000
        let interval = POLL_MIN_INTERVAL_MS

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const resp = await axios.get(`${DEFAULT_ACCURATE_BASE_URL}/extract-results/batch/${batchId}`, {
                headers: this.buildHeaders(token),
                timeout: 30000
            })

            const data = this.getDataOrThrow(resp.data, `MinerU precision batch polling failed for ${task.source}`)
            const extractResult = Array.isArray(data.extract_result) ? data.extract_result[0] : undefined
            if (!extractResult) {
                if (Date.now() > deadline) {
                    throw new Error(`MinerU precision batch timeout for ${task.source} (batch_id: ${batchId})`)
                }
                await this.sleep(interval)
                interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS)
                continue
            }

            const state = (extractResult.state as string) || 'unknown'
            if (state === 'done') {
                const zipUrl = extractResult.full_zip_url as string
                if (!zipUrl) throw new Error(`MinerU precision mode full_zip_url missing for ${task.source}`)
                const markdown = await this.downloadAccurateMarkdown(zipUrl, task.source)
                return {
                    markdown,
                    source: task.source,
                    page: task.page,
                    filename: (extractResult.file_name as string) || this.basename(task.source)
                }
            }

            if (state === 'failed') {
                throw new Error(
                    `MinerU precision mode failed for ${task.source}: ${extractResult.err_msg || 'unknown'} (code: ${
                        extractResult.err_code || '?'
                    })`
                )
            }

            if (Date.now() > deadline) {
                throw new Error(`MinerU precision batch timeout for ${task.source} (batch_id: ${batchId})`)
            }

            await this.sleep(interval)
            interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS)
        }
    }

    private async downloadAccurateMarkdown(zipUrl: string, source: string): Promise<string> {
        const zipResp = await axios.get(zipUrl, {
            responseType: 'arraybuffer',
            timeout: 180000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        })
        const zipBuffer = Buffer.from(zipResp.data)
        return this.extractMarkdownFromZip(zipBuffer, source)
    }

    private extractMarkdownFromZip(zipBuffer: Buffer, source: string): string {
        const eocdOffset = this.findEndOfCentralDirectory(zipBuffer)
        const centralDirectorySize = zipBuffer.readUInt32LE(eocdOffset + 12)
        const centralDirectoryOffset = zipBuffer.readUInt32LE(eocdOffset + 16)
        const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize

        let cursor = centralDirectoryOffset
        while (cursor + 46 <= centralDirectoryEnd && cursor + 46 <= zipBuffer.length) {
            const centralSignature = zipBuffer.readUInt32LE(cursor)
            if (centralSignature !== 0x02014b50) break

            const compressionMethod = zipBuffer.readUInt16LE(cursor + 10)
            const compressedSize = zipBuffer.readUInt32LE(cursor + 20)
            const fileNameLength = zipBuffer.readUInt16LE(cursor + 28)
            const extraFieldLength = zipBuffer.readUInt16LE(cursor + 30)
            const fileCommentLength = zipBuffer.readUInt16LE(cursor + 32)
            const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42)

            const fileNameStart = cursor + 46
            const fileNameEnd = fileNameStart + fileNameLength
            if (fileNameEnd > zipBuffer.length) {
                throw new Error(`MinerU precision mode zip is invalid for ${source}`)
            }
            const fileName = zipBuffer.subarray(fileNameStart, fileNameEnd).toString('utf-8')

            if (fileName.toLowerCase().endsWith('.md')) {
                const markdownBuffer = this.readZipEntry(zipBuffer, localHeaderOffset, compressedSize, compressionMethod, source)
                return markdownBuffer.toString('utf-8')
            }

            cursor = fileNameEnd + extraFieldLength + fileCommentLength
        }

        throw new Error(`MinerU precision mode zip has no markdown file for ${source}`)
    }

    private findEndOfCentralDirectory(zipBuffer: Buffer): number {
        const minOffset = Math.max(0, zipBuffer.length - 65557)
        for (let i = zipBuffer.length - 22; i >= minOffset; i -= 1) {
            if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
                return i
            }
        }
        throw new Error('MinerU precision mode zip parse failed: EOCD not found')
    }

    private readZipEntry(
        zipBuffer: Buffer,
        localHeaderOffset: number,
        compressedSize: number,
        compressionMethod: number,
        source: string
    ): Buffer {
        if (localHeaderOffset + 30 > zipBuffer.length) {
            throw new Error(`MinerU precision mode zip local header out of range for ${source}`)
        }

        const localSignature = zipBuffer.readUInt32LE(localHeaderOffset)
        if (localSignature !== 0x04034b50) {
            throw new Error(`MinerU precision mode invalid local header signature for ${source}`)
        }

        const fileNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26)
        const extraFieldLength = zipBuffer.readUInt16LE(localHeaderOffset + 28)
        const dataStart = localHeaderOffset + 30 + fileNameLength + extraFieldLength
        const dataEnd = dataStart + compressedSize
        if (dataEnd > zipBuffer.length) {
            throw new Error(`MinerU precision mode zip entry out of range for ${source}`)
        }

        const compressedData: Buffer = Buffer.from(zipBuffer.subarray(dataStart, dataEnd))
        if (compressionMethod === 0) {
            return compressedData
        }
        if (compressionMethod === 8) {
            return inflateRawSync(compressedData)
        }
        throw new Error(`MinerU precision mode unsupported zip compression method: ${compressionMethod}`)
    }

    private buildAccurateOptions(config: MinerUPrecisionConfig, pageRange?: string): Record<string, unknown> {
        const modelVersion = this.resolveModelVersion(config.model)
        const options: Record<string, unknown> = {
            model_version: modelVersion
        }

        if (config.ocr) options.is_ocr = true
        if (!config.formula) options.enable_formula = false
        if (!config.table) options.enable_table = false
        if (config.language) options.language = config.language
        if (pageRange) options.page_ranges = pageRange

        return options
    }

    private resolveModelVersion(model: PrecisionModel): string {
        if (model === 'pipeline') return 'pipeline'
        if (model === 'vlm') return 'vlm'
        return 'MinerU-HTML'
    }

    private resolveModelLabel(nodeData: INodeData): string {
        const inputModel = (nodeData.inputs?.model as string) || (nodeData.inputs?.accurateModel as string) || 'pipeline'
        return this.resolveModelInput(inputModel)
    }

    private resolveMode(rawMode?: string): MinerUMode {
        if (rawMode === 'precision' || rawMode === 'accurate') return 'precision'
        return 'flash'
    }

    private resolveModelInput(rawModel?: string): PrecisionModel {
        if (rawModel === 'vlm' || rawModel === 'pipeline' || rawModel === 'html') return rawModel
        if (rawModel === 'MinerU-HTML') return 'html'
        return 'pipeline'
    }

    private validateSourceTypeByMode(source: string, mode: MinerUMode): void {
        const ext = this.getSourceExtension(source)
        if (!ext) {
            throw new Error(`Cannot detect file type from source: ${source}`)
        }

        const allowed = mode === 'flash' ? FLASH_ALLOWED_EXTENSIONS : PRECISION_ALLOWED_EXTENSIONS
        if (allowed.includes(ext)) return

        const allowedText = mode === 'flash' ? FLASH_ALLOWED_FORMATS_TEXT : PRECISION_ALLOWED_FORMATS_TEXT
        throw new Error(`Unsupported file type ".${ext}" for ${mode} mode. Allowed: ${allowedText}. Source: ${source}`)
    }

    private getSourceExtension(source: string): string | undefined {
        const cleaned = source.split('#')[0].split('?')[0]
        const baseName = this.basename(cleaned)
        const dotIndex = baseName.lastIndexOf('.')
        if (dotIndex <= 0 || dotIndex === baseName.length - 1) return undefined
        return baseName.slice(dotIndex + 1).toLowerCase()
    }

    private parsePageRange(pageRange: string): number[] {
        const pages = new Set<number>()
        const parts = pageRange
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)

        if (!parts.length) {
            throw new Error('Page Range is empty')
        }

        for (const part of parts) {
            const rangeMatch = part.match(/^(\d+)\s*-+\s*(\d+)$/)
            if (rangeMatch) {
                const start = Number(rangeMatch[1])
                const end = Number(rangeMatch[2])
                if (start <= 0 || end <= 0 || start > end) {
                    throw new Error(`Invalid page range: ${part}`)
                }
                for (let page = start; page <= end; page += 1) {
                    pages.add(page)
                }
                continue
            }

            const singleMatch = part.match(/^\d+$/)
            if (singleMatch) {
                const page = Number(part)
                if (page <= 0) throw new Error(`Invalid page number: ${part}`)
                pages.add(page)
                continue
            }

            throw new Error(`Invalid page range expression: ${part}`)
        }

        return Array.from(pages).sort((a, b) => a - b)
    }

    private buildHeaders(token?: string): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            source: DEFAULT_SOURCE_HEADER
        }
        if (token) {
            headers.Authorization = `Bearer ${token}`
        }
        return headers
    }

    private getDataOrThrow(payload: unknown, errorPrefix: string): Record<string, unknown> {
        if (!payload || typeof payload !== 'object') {
            throw new Error(`${errorPrefix}: invalid response payload`)
        }
        const body = payload as Record<string, unknown>
        const code = body.code
        if (typeof code !== 'number' || code !== 0) {
            throw new Error(`${errorPrefix}: ${(body.msg as string) || JSON.stringify(body)}`)
        }
        const data = body.data
        if (!data || typeof data !== 'object') {
            throw new Error(`${errorPrefix}: missing data`)
        }
        return data as Record<string, unknown>
    }

    private looksLikeUrl(value: string): boolean {
        return value.startsWith('http://') || value.startsWith('https://')
    }

    private looksLikePdf(value: string): boolean {
        const cleaned = value.split('#')[0].split('?')[0]
        return cleaned.toLowerCase().endsWith('.pdf')
    }

    private basename(value: string): string {
        const cleaned = value.split('#')[0].split('?')[0]
        const segments = cleaned.split('/')
        const name = segments[segments.length - 1]
        return name || 'upload_file'
    }

    private asBoolean(value: unknown, defaultValue: boolean): boolean {
        if (typeof value === 'boolean') return value
        if (typeof value === 'string') return value.toLowerCase() === 'true'
        if (typeof value === 'number') return value !== 0
        return defaultValue
    }

    private resolveTimeoutSeconds(value: unknown): number {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return Math.floor(value)
        }
        if (typeof value === 'string') {
            const parsed = Number(value)
            if (Number.isFinite(parsed) && parsed > 0) {
                return Math.floor(parsed)
            }
        }
        return DEFAULT_TIMEOUT_SECONDS
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            setTimeout(resolve, ms)
        })
    }
}

module.exports = { nodeClass: MinerU_DocumentLoaders }
