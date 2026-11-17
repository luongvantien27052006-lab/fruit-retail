// ESLint flat config dùng chung (TS). App có thể mở rộng.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/build/**', '**/.next/**', '**/node_modules/**', '**/generated/**', '**/.dart_tool/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      // ADR-016: không monkey-patch BigInt để JSON.stringify; dùng codec của money_weight.
      'no-restricted-syntax': [
        'error',
        { selector: "AssignmentExpression[left.object.object.name='BigInt'][left.property.name='toJSON']", message: 'Dùng toWire()/fromWire() của @fruit/money_weight (ADR-016).' },
        { selector: "CallExpression[callee.name='parseFloat']", message: 'Cấm số thực cho tiền/cân (FR-INV-01/02).' },
      ],
    },
  },
);
