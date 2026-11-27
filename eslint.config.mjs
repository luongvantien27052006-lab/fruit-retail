// ESLint flat config dùng chung (TS). App có thể mở rộng.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/build/**', '**/.next/**', '**/node_modules/**', '**/generated/**', '**/.dart_tool/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      // Module NestJS là class có decorator và chỉ có thành viên static (forRoot) — hợp lệ.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
      // ADR-016: không monkey-patch BigInt để JSON.stringify; dùng codec của money_weight.
      'no-restricted-syntax': [
        'error',
        {
          selector: "AssignmentExpression[left.object.object.name='BigInt'][left.property.name='toJSON']",
          message: 'Dùng toWire()/fromWire() của @fruit/money_weight (ADR-016).',
        },
        { selector: "CallExpression[callee.name='parseFloat']", message: 'Cấm số thực cho tiền/cân (FR-INV-01/02).' },
      ],
    },
  },
  {
    // ADR-016/020: nghiệp vụ truy cập DB qua TransactionHost (client chặn ghi ngoài transaction); client thô chỉ cho hạ tầng
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/infra/**', 'apps/api/src/health/**', 'apps/api/src/db/**', 'apps/api/src/worker*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infra/prisma.service', '**/generated/prisma/client'],
              importNames: ['PrismaService', 'PrismaClient'],
              message: 'Dùng TransactionHost (client TX_PRISMA) — không dùng Prisma thô ngoài src/infra (ADR-016).',
            },
          ],
        },
      ],
    },
  },
);
