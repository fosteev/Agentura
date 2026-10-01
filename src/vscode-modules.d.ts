/** Фикстуры состояний (`test/fixtures/states/*.jsonl`) esbuild подключает как текст — только в сборке расширения. */
declare module '*.jsonl' {
  const text: string;
  export default text;
}
