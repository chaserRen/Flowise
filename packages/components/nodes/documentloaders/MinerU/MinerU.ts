import { omit } from 'lodash'
import axios from 'axios'
import { IDocument, ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'
import { TextSplitter } from 'langchain/text_splitter'
import { getFileFromStorage, handleEscapeCharacters, INodeOutputsValue } from '../../../src'

// TODO: 正式环境上线后替换为 https://mineru.net/api/v1/agent
const DEFAULT_BASE_URL = 'https://staging.mineru.org.cn/api/v1/agent'

const SUPPORTED_FILE_TYPES = '.pdf,.png,.jpg,.jpeg,.jp2,.webp,.gif,.bmp,.doc,.docx,.ppt,.pptx'

const REQUEST_HEADERS: Record<string, string> = {
    'Content-Type': 'application/json',
    source: 'Flowise'
}

interface MinerUTaskResult {
    markdown: string
    source: string
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
        this.version = 1.0
        this.type = 'Document'
        this.icon = 'mineru.svg'
        this.category = 'Document Loaders'
        this.description = 'Load and parse documents using MinerU Flash (Agent) lightweight extraction API'
        this.baseClasses = [this.type]
        this.inputs = [
            {
                label: 'Text Splitter',
                name: 'textSplitter',
                type: 'TextSplitter',
                optional: true
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
                description: 'One URL per line, or separated by commas. Supports PDF, images, Doc/Docx, PPT/PPTx.',
                placeholder: 'https://arxiv.org/pdf/2603.16181v1,https://arxiv.org/pdf/2312.10997',
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
                label: 'Language',
                name: 'language',
                type: 'string',
                description:
                    'Ocr language hint. Default: ch. Common values: ch (Chinese), en (English), auto (automatic detection). For the complete list, please refer to the <a href="https://mineru.net/apiManage/docs" target="_blank" rel="noopener noreferrer">standard API documentation</a>.',
                placeholder: 'ch',
                optional: true
            },
            {
                label: 'Page Range',
                name: 'pageRange',
                type: 'string',
                description: 'Page range for PDF files only. e.g. 1-10 or 5',
                placeholder: '1-10',
                optional: true
            },
            {
                label: 'Additional Metadata',
                name: 'metadata',
                type: 'json',
                description: 'Additional metadata to be added to the extracted documents',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Omit Metadata Keys',
                name: 'omitMetadataKeys',
                type: 'string',
                rows: 4,
                description:
                    'Each document loader comes with a default set of metadata keys that are extracted from the document. You can use this field to omit some of the default metadata keys. The value should be a list of keys, seperated by comma. Use * to omit all metadata keys execept the ones you specify in the Additional Metadata field',
                placeholder: 'key1, key2, key3.nestedKey1',
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
        const inputMode = nodeData.inputs?.inputMode as string
        const metadata = nodeData.inputs?.metadata
        const _omitMetadataKeys = nodeData.inputs?.omitMetadataKeys as string
        const output = nodeData.outputs?.output as string
        const language = (nodeData.inputs?.language as string) || ''
        const pageRange = (nodeData.inputs?.pageRange as string) || ''
        const baseUrl = DEFAULT_BASE_URL

        let omitMetadataKeys: string[] = []
        if (_omitMetadataKeys) {
            omitMetadataKeys = _omitMetadataKeys.split(',').map((key) => key.trim())
        }

        let results: MinerUTaskResult[] = []

        if (inputMode === 'file') {
            results = await this.handleFileUpload(nodeData, options, baseUrl, language, pageRange)
        } else {
            results = await this.handleUrlMode(nodeData, baseUrl, language, pageRange)
        }

        let docs: IDocument[] = results
            .filter((r) => r.markdown)
            .map((r) => ({
                pageContent: r.markdown,
                metadata: {
                    source: r.source,
                    parser: 'mineru'
                }
            }))

        if (textSplitter) {
            docs = await textSplitter.splitDocuments(docs)
        }

        if (metadata) {
            const parsedMetadata = typeof metadata === 'object' ? metadata : JSON.parse(metadata)
            docs = docs.map((doc) => ({
                ...doc,
                metadata: _omitMetadataKeys === '*' ? { ...parsedMetadata } : omit({ ...doc.metadata, ...parsedMetadata }, omitMetadataKeys)
            }))
        } else {
            docs = docs.map((doc) => ({
                ...doc,
                metadata: _omitMetadataKeys === '*' ? {} : omit({ ...doc.metadata }, omitMetadataKeys)
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

    private async handleUrlMode(nodeData: INodeData, baseUrl: string, language: string, pageRange: string): Promise<MinerUTaskResult[]> {
        const fileUrls = nodeData.inputs?.fileUrls as string
        if (!fileUrls) throw new Error('File URLs are required in URL mode')

        const urls = fileUrls
            .split(/[\n,]/)
            .map((u: string) => u.trim())
            .filter(Boolean)
        if (urls.length === 0) throw new Error('No valid URLs provided')

        const results: MinerUTaskResult[] = []
        for (const url of urls) {
            const result = await this.submitUrlTask(url, baseUrl, language, pageRange)
            results.push(result)
        }
        return results
    }

    private async handleFileUpload(
        nodeData: INodeData,
        options: ICommonObject,
        baseUrl: string,
        language: string,
        pageRange: string
    ): Promise<MinerUTaskResult[]> {
        const fileUploadValue = nodeData.inputs?.fileUpload as string
        if (!fileUploadValue) throw new Error('File upload is required in File Upload mode')

        let fileNames: string[] = []
        const results: MinerUTaskResult[] = []

        if (fileUploadValue.startsWith('FILE-STORAGE::')) {
            const raw = fileUploadValue.replace('FILE-STORAGE::', '')
            fileNames = raw.startsWith('[') && raw.endsWith(']') ? JSON.parse(raw) : [raw]

            const orgId = options.orgId
            const chatflowid = options.chatflowid

            for (const fileName of fileNames) {
                if (!fileName) continue
                const fileData = await getFileFromStorage(fileName, orgId, chatflowid)
                const buffer = Buffer.isBuffer(fileData) ? fileData : Buffer.from(fileData)
                const result = await this.submitFileTask(fileName, buffer, baseUrl, language, pageRange)
                results.push(result)
            }
        } else {
            const rawFiles =
                fileUploadValue.startsWith('[') && fileUploadValue.endsWith(']') ? JSON.parse(fileUploadValue) : [fileUploadValue]

            for (const file of rawFiles) {
                if (!file) continue
                const splitDataURI = file.split(',')
                splitDataURI.pop()
                const buffer = Buffer.from(splitDataURI.pop() || '', 'base64')
                const guessedName = `upload_${Date.now()}.pdf`
                const result = await this.submitFileTask(guessedName, buffer, baseUrl, language, pageRange)
                results.push(result)
            }
        }
        return results
    }

    private async submitUrlTask(url: string, baseUrl: string, language: string, pageRange: string): Promise<MinerUTaskResult> {
        const payload: Record<string, string> = { url }
        if (language) payload.language = language
        if (pageRange) payload.page_range = pageRange

        const resp = await axios.post(`${baseUrl}/parse/url`, payload, {
            headers: REQUEST_HEADERS,
            timeout: 30000
        })

        if (resp.data.code !== 0) {
            throw new Error(`MinerU submit failed for ${url}: ${resp.data.msg || JSON.stringify(resp.data)}`)
        }

        const taskId = resp.data.data.task_id
        return this.pollAndDownload(taskId, url, baseUrl)
    }

    private async submitFileTask(
        fileName: string,
        fileBuffer: Buffer,
        baseUrl: string,
        language: string,
        pageRange: string
    ): Promise<MinerUTaskResult> {
        const payload: Record<string, string> = { file_name: fileName }
        if (language) payload.language = language
        if (pageRange) payload.page_range = pageRange

        const resp = await axios.post(`${baseUrl}/parse/file`, payload, {
            headers: REQUEST_HEADERS,
            timeout: 30000
        })

        if (resp.data.code !== 0) {
            throw new Error(`MinerU file submit failed for ${fileName}: ${resp.data.msg || JSON.stringify(resp.data)}`)
        }

        const taskId = resp.data.data.task_id
        const fileUrl = resp.data.data.file_url

        await axios.put(fileUrl, fileBuffer, {
            headers: { 'Content-Type': '' },
            timeout: 120000,
            transformRequest: [(data: Buffer) => data],
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        })

        return this.pollAndDownload(taskId, fileName, baseUrl)
    }

    private async pollAndDownload(taskId: string, source: string, baseUrl: string): Promise<MinerUTaskResult> {
        let interval = 2000
        const deadline = Date.now() + 600000

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const resp = await axios.get(`${baseUrl}/parse/${taskId}`, {
                headers: { source: 'flowise' },
                timeout: 30000
            })

            if (resp.data.code !== 0) {
                throw new Error(`MinerU poll error for ${source}: ${resp.data.msg || 'unknown'}`)
            }

            const data = resp.data.data || {}
            const state = data.state || 'unknown'

            if (state === 'done') {
                const markdownUrl = data.markdown_url
                if (!markdownUrl) throw new Error(`MinerU: markdown_url missing for ${source}`)

                const mdResp = await axios.get(markdownUrl, { timeout: 120000 })

                return {
                    markdown: mdResp.data as string,
                    source
                }
            }

            if (state === 'failed') {
                throw new Error(`MinerU parsing failed for ${source}: ${data.err_msg || 'unknown'} (code: ${data.err_code || '?'})`)
            }

            if (Date.now() > deadline) {
                throw new Error(`MinerU polling timeout for ${source} (task_id: ${taskId})`)
            }

            await new Promise((resolve) => setTimeout(resolve, interval))
            interval = Math.min(interval * 2, 15000)
        }
    }
}

module.exports = { nodeClass: MinerU_DocumentLoaders }
