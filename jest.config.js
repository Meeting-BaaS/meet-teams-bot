/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    transform: {
        '^.+\\.(ts|tsx)$': [
            'ts-jest',
            {
                tsconfig: 'tsconfig.json',
            },
        ],
    },
    testMatch: ['**/src/**/*.test.ts', '**/src/**/*.spec.ts'],
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        // https-proxy-agent is ESM-only and node_modules is not transformed, so
        // importing it aborts the whole suite at parse time. Nothing under test
        // proxies anything — swap in a stub to keep the import graph loadable.
        '^https-proxy-agent$': '<rootDir>/test/mocks/https-proxy-agent.ts',
    },
}
