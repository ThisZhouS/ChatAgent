import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import type { DocumentSummary } from '@chatagent/contracts';
import DocumentsView from './DocumentsView.vue';

const mocks = vi.hoisted(() => ({
  parse: vi.fn(),
  list: vi.fn(async () => ({ artifacts: [], uploads: [] })),
  downloadUrl: vi.fn((id: string) => `/api/files/${id}`),
}));

vi.mock('../api', () => ({
  api: {
    files: { list: mocks.list, downloadUrl: mocks.downloadUrl },
    documents: {
      parse: mocks.parse,
      generateWord: vi.fn(async () => ({ id: 'w1', name: 'a.docx' })),
      generateExcel: vi.fn(async () => ({ id: 'e1', name: 'a.xlsx' })),
    },
  },
}));

const summary: DocumentSummary = {
  fileId: 'f1',
  fileName: '预算表.xlsx',
  kind: 'excel',
  textPreview: '[Sheet1] 12 rows x 4 columns',
  sheets: [
    {
      name: 'Sheet1',
      rows: 12,
      columns: 4,
      preview: [
        { 项目: '差旅', 预算: '12000', 已用: '3400' },
        { 项目: '培训', 预算: '8000', 已用: '8000' },
      ],
    },
    { name: '空表', rows: 0, columns: 0, preview: [] },
  ],
};

beforeEach(() => {
  mocks.parse.mockReset();
  mocks.list.mockClear();
});

async function mountAndParse() {
  const wrapper = mount(DocumentsView, { global: { plugins: [ElementPlus] } });
  await flushPromises();

  const input = wrapper.find('input[type="file"]');
  expect(input.exists(), 'the upload control exposes a file input').toBe(true);
  const file = new File(['x'], '预算表.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
  await flushPromises();
  return wrapper;
}

describe('DocumentsView', () => {
  it('renders the parsed spreadsheet preview rows instead of only counts', async () => {
    mocks.parse.mockResolvedValueOnce({ summary });
    const wrapper = await mountAndParse();

    expect(mocks.parse).toHaveBeenCalledTimes(1);
    // Header keys become real table columns and the values are visible.
    const text = wrapper.text();
    expect(text).toContain('差旅');
    expect(text).toContain('12000');
    expect(text).toContain('培训');
    expect(text).toContain('8000');
    expect(text).toContain('工作表 Sheet1');
    expect(text).toContain('预览前 2 行');
    // A sheet with no data rows degrades to an explicit notice.
    expect(text).toContain('该表除表头外没有数据行');
    wrapper.unmount();
  });

  it('surfaces parse failures without wiping the previous state', async () => {
    mocks.parse.mockRejectedValueOnce(new Error('文件过大'));
    const wrapper = await mountAndParse();
    expect(wrapper.text()).toContain('文件过大');
    wrapper.unmount();
  });
});
