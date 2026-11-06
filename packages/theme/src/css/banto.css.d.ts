// `@banto/theme/css`（package.json の exports の `./css`）の型。
//
// CSS は副作用の import（`import '@banto/theme/css'`）専用で、値は何も export しない。
// TypeScript 6 は副作用の import も解決を検査する（`noUncheckedSideEffectImports`）ので、
// 利用する側が自前で `declare module` を置かずに済むよう、提供元のここで空のモジュールと
// して宣言する。架空の default export やクラス名の型は作らない（実行時の挙動は変えない）。
//
// 解決は exports の `types` 条件による。`moduleResolution: "bundler"`（SvelteKit 3 の
// `$app/tsconfig` の既定）を前提にしている（#325）。
export {};
