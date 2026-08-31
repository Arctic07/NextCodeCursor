import antfu from '@antfu/eslint-config'

export default antfu({
  typescript: true,
  ignores: [
    'src/server/gen/**',
    'src/server/handlers/**',
    'src/server/services/**',
    'src/server/database/blobs.ts',
    'src/server/database/checkpoints.ts',
    'src/server/database/chatSummaries.ts',
    'src/server/relay/**',
    'dist/**',
    'out/**',
    'obfuscate.js',
    'esbuild.js',
    'package.json',
    'tsconfig.json',
  ],
}, {
  rules: {
    'no-console': 'off',
    'node/prefer-global/process': 'off',
    'node/prefer-global/buffer': 'off',
    'ts/no-require-imports': 'off',
  },
})
