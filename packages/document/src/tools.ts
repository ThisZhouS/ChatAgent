import { generateExcelSchema, generateWordSchema } from '@chatagent/contracts';
import { makeTool } from '@chatagent/hermes';
import type { Tool, ToolContext, ToolResult } from '@chatagent/hermes';
import { parseDocumentBuffer } from './document-service';
import { createExcelBuffer } from './excel';
import { createWordBuffer } from './word';

export interface ResolvedFile {
  id: string;
  name: string;
  buffer: Buffer;
}

/** Server-trusted ownership scope; never derived from tool arguments. */
export interface ArtifactScope {
  organizationId: string;
  ownerId: string;
  taskId?: string;
  runId?: string;
}

export interface SavedArtifact {
  id: string;
  name: string;
  mimeType: string;
  url?: string;
  localPath?: string;
}

export interface DocumentToolOptions {
  /** Resolution must be scoped by the caller using the trusted tool context. */
  resolveFile?: (ref: string, context: ToolContext) => Promise<ResolvedFile | undefined>;
  saveArtifact?: (
    buffer: Buffer,
    name: string,
    mimeType: string,
    scope: ArtifactScope,
  ) => Promise<SavedArtifact>;
}

const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function createDocumentTools(options: DocumentToolOptions = {}): Tool[] {
  return [
    makeTool(
      {
        name: 'parse_document',
        description:
          'Parse an uploaded Word/Excel/CSV/text document and return a structured preview. Use this when the human attaches or references a file.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute local path of the uploaded file.' },
            fileName: { type: 'string', description: 'Uploaded file name or id to resolve.' },
            fileId: { type: 'string', description: 'Uploaded file id.' },
          },
        },
      },
      async (args, context) => {
        const ref = firstString(args, ['filePath', 'fileName', 'fileId']);
        if (!ref) {
          return failure('parse_document 需要一个字符串类型的 filePath、fileName 或 fileId。');
        }

        const file = await options.resolveFile?.(ref, context);
        if (!file) {
          return failure(`未找到可访问的上传文件：${ref}。请先上传文件。`);
        }

        const summary = await parseDocumentBuffer(file.buffer, file.name, file.id);
        return {
          ok: true,
          output: summary,
          summary: `Parsed ${file.name} (${summary.kind}): ${summary.textPreview.slice(0, 300)}`,
        };
      },
    ),
    makeTool(
      {
        name: 'create_word_document',
        description: 'Create a Word (.docx) document from a title, paragraphs and an optional table.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            paragraphs: { type: 'array', items: { type: 'string' } },
            table: {
              type: 'object',
              properties: {
                header: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
              },
            },
          },
          required: ['title'],
        },
      },
      async (args, context) => {
        const parsed = generateWordSchema.safeParse(args);
        if (!parsed.success) {
          return failure(`create_word_document 参数校验失败：${formatIssues(parsed.error.issues)}`);
        }
        if (!options.saveArtifact) {
          return failure('服务端未配置产物存储，已拒绝生成，避免产生无归属文件。');
        }
        const scope = scopeFrom(context);
        if (!scope) {
          return failure('缺少服务端可信的任务归属信息，已拒绝生成文件。');
        }

        const buffer = await createWordBuffer(parsed.data);
        const fileName = `${safeFileName(parsed.data.title)}.docx`;
        const artifact = await options.saveArtifact(buffer, fileName, WORD_MIME, scope);
        return {
          ok: true,
          output: { fileName, sizeBytes: buffer.byteLength, artifact },
          summary: `Created Word document ${fileName} (${buffer.byteLength} bytes).`,
        };
      },
    ),
    makeTool(
      {
        name: 'create_excel_document',
        description: 'Create an Excel (.xlsx) workbook from one or more sheets.',
        parameters: {
          type: 'object',
          properties: {
            fileName: { type: 'string' },
            sheets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  header: { type: 'array', items: { type: 'string' } },
                  rows: {
                    type: 'array',
                    items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
                  },
                },
                required: ['name', 'header', 'rows'],
              },
            },
          },
          required: ['sheets'],
        },
      },
      async (args, context) => {
        const parsed = generateExcelSchema.safeParse(args);
        if (!parsed.success) {
          return failure(`create_excel_document 参数校验失败：${formatIssues(parsed.error.issues)}`);
        }
        if (!options.saveArtifact) {
          return failure('服务端未配置产物存储，已拒绝生成，避免产生无归属文件。');
        }
        const scope = scopeFrom(context);
        if (!scope) {
          return failure('缺少服务端可信的任务归属信息，已拒绝生成文件。');
        }

        const buffer = createExcelBuffer(parsed.data);
        const artifact = await options.saveArtifact(buffer, parsed.data.fileName, EXCEL_MIME, scope);
        return {
          ok: true,
          output: { fileName: parsed.data.fileName, sizeBytes: buffer.byteLength, artifact },
          summary: `Created Excel workbook ${parsed.data.fileName} (${buffer.byteLength} bytes).`,
        };
      },
    ),
  ];
}

function scopeFrom(context: ToolContext): ArtifactScope | undefined {
  if (!context.organizationId || !context.ownerId) return undefined;
  return {
    organizationId: context.organizationId,
    ownerId: context.ownerId,
    taskId: context.taskId,
    runId: context.runId,
  };
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

function failure(summary: string): ToolResult {
  return { ok: false, output: null, summary };
}

function formatIssues(issues: { path: (string | number)[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

function safeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80);
  return cleaned || 'document';
}
