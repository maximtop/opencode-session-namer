const customRules = {
    'max-len': ['error', {
        code: 80,
        ignorePattern: '^\\s*(logger\\.|console\\.)',
        ignoreStrings: true,
        ignoreComments: true,
    }],
    'import/extensions': ['error', 'never', {
        js: 'never',
        ts: 'never',
    }],
    'import/prefer-default-export': 'off',
    'import/no-extraneous-dependencies': ['error', {
        devDependencies: [
            '**/*.config.js',
            '**/*.config.cjs',
            '**/*.config.ts',
            'tests/**/*',
        ],
    }],
    'no-restricted-syntax': 'off',
    'no-continue': 'off',
    'no-await-in-loop': 'off',
    'object-curly-newline': ['error', { consistent: true }],
    'jsdoc/check-indentation': 'error',
    'jsdoc/require-jsdoc': 'off',
};

module.exports = {
    root: true,
    env: {
        node: true,
        es2022: true,
    },
    extends: [
        'airbnb-base',
        'plugin:jsdoc/recommended',
    ],
    plugins: ['import', 'jsdoc'],
    parserOptions: {
        ecmaVersion: 'latest',
    },
    ignorePatterns: [
        'node_modules/',
        '.test-fixtures/',
        'coverage/',
    ],
    rules: {
        ...customRules,
        indent: ['error', 4, { SwitchCase: 1 }],
    },
    overrides: [
        {
            files: ['*.ts', 'src/**/*.ts', 'tests/**/*.ts'],
            parser: '@typescript-eslint/parser',
            parserOptions: {
                project: './tsconfig.json',
            },
            extends: [
                'airbnb-base',
                'airbnb-typescript/base',
                'plugin:jsdoc/recommended-typescript',
            ],
            rules: {
                ...customRules,
                indent: 'off',
                '@typescript-eslint/indent': ['error', 4, { SwitchCase: 1 }],
            },
        },
        {
            files: ['tests/**/*.ts'],
            rules: {
                'jsdoc/require-jsdoc': 'off',
                'jsdoc/require-param': 'off',
                'jsdoc/require-returns': 'off',
                'no-param-reassign': 'off',
            },
        },
    ],
};
