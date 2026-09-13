declare module 'mammoth' {
  const mammoth: {
    extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
  };
  export = mammoth;
}
