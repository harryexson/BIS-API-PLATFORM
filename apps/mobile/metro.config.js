// This app lives inside an npm-workspaces monorepo (apps/mobile). npm hoists
// shared/compatible dependencies to the monorepo root's node_modules, but
// Metro's default resolver only looks inside this project's own
// node_modules. Without this config, any hoisted package (which in
// practice ends up being most of them) fails to resolve at bundle time.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole workspace so changes to shared packages (if this app ever
// imports one, e.g. a shared schema/types package) trigger a rebuild.
config.watchFolders = [workspaceRoot];

// In addition to Metro's normal hierarchical node_modules walk (which
// already finds npm's *nested* deps, e.g. expo's own expo-modules-core),
// also check the workspace root directly for anything npm *hoisted* there
// instead of nesting.
config.resolver.nodeModulesPaths = [path.resolve(workspaceRoot, 'node_modules')];

module.exports = config;
