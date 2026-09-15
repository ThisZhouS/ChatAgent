<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { UploadFilled } from '@element-plus/icons-vue';
import type { DocumentSummary } from '@chatagent/contracts';
import { api, type FileListView, type StoredFileView } from '../api';

const files = ref<FileListView>({ artifacts: [], uploads: [] });
const summary = ref<DocumentSummary | null>(null);
const error = ref('');
const loading = ref(false);

const wordTitle = ref('工作汇报');
const wordParagraphs = ref('第一段内容\n第二段内容');
const wordResult = ref<StoredFileView | null>(null);

const excelName = ref('数据表.xlsx');
const excelSheet = ref('Sheet1');
const excelHeader = ref('项目,值');
const excelRows = ref('状态,完成\n负责人,ChatAgent');
const excelResult = ref<StoredFileView | null>(null);

/** 预览表格最多渲染的列数（超出时提示，避免宽表撑破卡片）。 */
const MAX_PREVIEW_COLUMNS = 8;

/** 工作表预览的列：取自首行记录的键（服务端已按表头生成）。 */
function sheetColumns(sheet: { preview: Record<string, unknown>[] }): string[] {
  const first = sheet.preview[0];
  return first ? Object.keys(first).slice(0, MAX_PREVIEW_COLUMNS) : [];
}

function sheetColumnsTruncated(sheet: { preview: Record<string, unknown>[] }): boolean {
  const first = sheet.preview[0];
  return first ? Object.keys(first).length > MAX_PREVIEW_COLUMNS : false;
}

async function loadFiles() {
  try {
    files.value = await api.files.list();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function parse(file: File) {
  loading.value = true;
  error.value = '';
  try {
    const result = await api.documents.parse(file);
    summary.value = result.summary;
    await loadFiles();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function onFileChange(uploadFile: { raw?: File }) {
  if (uploadFile.raw) void parse(uploadFile.raw);
}

async function generateWord() {
  error.value = '';
  try {
    const result = await api.documents.generateWord({
      title: wordTitle.value,
      paragraphs: wordParagraphs.value.split('\n').filter(Boolean),
      table: { header: ['项目', '状态'], rows: [['文档', '已生成']] },
    });
    wordResult.value = result;
    await loadFiles();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function generateExcel() {
  error.value = '';
  try {
    const header = excelHeader.value.split(',').map((item) => item.trim());
    const rows = excelRows.value
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(',').map((cell) => cell.trim()));
    const result = await api.documents.generateExcel({
      fileName: excelName.value,
      sheets: [{ name: excelSheet.value, header, rows }],
    });
    excelResult.value = result;
    await loadFiles();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(() => void loadFiles());
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>文件</h2>
        <p class="subtitle">解析、生成 Word 与 Excel，并作为 Agent 工具使用。</p>
      </div>
    </div>

    <el-alert v-if="error" :title="error" type="error" show-icon class="card" />

    <el-row :gutter="16">
      <el-col :span="12">
        <el-card shadow="never">
          <template #header>解析上传文件</template>
          <el-upload
            drag
            :auto-upload="false"
            :show-file-list="false"
            :on-change="onFileChange"
            accept=".docx,.xlsx,.xls,.csv,.txt,.md"
          >
            <el-icon size="32"><UploadFilled /></el-icon>
            <div class="el-upload__text">拖拽文件到此处，或点击上传</div>
            <template #tip>
              <div class="stat-label">支持 Word / Excel / CSV / 文本</div>
            </template>
          </el-upload>

          <div v-if="loading" class="stat-label" style="margin-top: 12px">解析中…</div>
          <div v-if="summary" style="margin-top: 12px">
            <div style="display: flex; justify-content: space-between; align-items: center">
              <strong>{{ summary.fileName }}</strong>
              <el-tag type="success">{{ summary.kind }}</el-tag>
            </div>
            <pre style="white-space: pre-wrap; max-height: 200px; overflow: auto; background: #f5f7fa; padding: 10px; border-radius: 8px">{{ summary.textPreview }}</pre>
            <div v-if="summary.sheets?.length" class="sheet-preview">
              <div v-for="sheet in summary.sheets" :key="sheet.name" class="sheet-block">
                <div class="stat-label">
                  工作表 {{ sheet.name }}（{{ sheet.rows }} 行 × {{ sheet.columns }} 列；预览前
                  {{ sheet.preview.length }} 行）
                </div>
                <el-table
                  v-if="sheet.preview.length"
                  :data="sheet.preview"
                  size="small"
                  max-height="220"
                  style="width: 100%"
                  :data-testid="`sheet-preview-${sheet.name}`"
                >
                  <el-table-column
                    v-for="key in sheetColumns(sheet)"
                    :key="key"
                    :prop="key"
                    :label="key"
                    min-width="110"
                    show-overflow-tooltip
                  />
                </el-table>
                <div v-else class="stat-label">（该表除表头外没有数据行）</div>
                <div v-if="sheetColumnsTruncated(sheet)" class="stat-label">
                  仅显示前 {{ MAX_PREVIEW_COLUMNS }} 列，完整数据请下载原文件查看。
                </div>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="12">
        <el-card shadow="never">
          <template #header>生成 Word</template>
          <el-form label-position="top">
            <el-form-item label="标题">
              <el-input v-model="wordTitle" />
            </el-form-item>
            <el-form-item label="段落（每行一段）">
              <el-input v-model="wordParagraphs" type="textarea" :rows="4" />
            </el-form-item>
            <el-button type="primary" @click="generateWord">生成 .docx</el-button>
          </el-form>
          <div v-if="wordResult" style="margin-top: 8px">
            已生成：
            <el-link :href="api.files.downloadUrl(wordResult.id)" type="primary">{{ wordResult.name }}</el-link>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header>生成 Excel</template>
          <el-form label-position="top">
            <el-row :gutter="12">
              <el-col :span="12">
                <el-form-item label="文件名">
                  <el-input v-model="excelName" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="Sheet 名">
                  <el-input v-model="excelSheet" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-form-item label="表头（逗号分隔）">
              <el-input v-model="excelHeader" />
            </el-form-item>
            <el-form-item label="数据行（每行一条，逗号分隔）">
              <el-input v-model="excelRows" type="textarea" :rows="4" />
            </el-form-item>
            <el-button type="primary" @click="generateExcel">生成 .xlsx</el-button>
          </el-form>
          <div v-if="excelResult" style="margin-top: 8px">
            已生成：
            <el-link :href="api.files.downloadUrl(excelResult.id)" type="primary">{{ excelResult.name }}</el-link>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never">
      <template #header>文件库</template>
      <el-table :data="[...files.artifacts, ...files.uploads]" style="width: 100%">
        <el-table-column prop="name" label="名称" min-width="220" />
        <el-table-column label="类型" width="120">
          <template #default="{ row }">
            <el-tag size="small">{{ row.url ? '生成物' : '上传' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="sizeBytes" label="大小" width="120" />
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-link v-if="row.url" :href="api.files.downloadUrl(row.id)" type="primary">下载</el-link>
            <span v-else class="stat-label">—</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.sheet-preview {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sheet-block .stat-label {
  margin-bottom: 6px;
}
</style>
