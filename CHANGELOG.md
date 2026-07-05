# Changelog

## [1.7.1](https://github.com/KochC/opencode-llm-proxy/compare/v1.7.0...v1.7.1) (2026-07-05)


### Bug Fixes

* address Copilot review follow-ups from [#56](https://github.com/KochC/opencode-llm-proxy/issues/56); docs: add n8n integration guide ([55a38e0](https://github.com/KochC/opencode-llm-proxy/commit/55a38e0489fa468c021533c454df907b18f74d4a))
* address Copilot review follow-ups from [#56](https://github.com/KochC/opencode-llm-proxy/issues/56); docs: add n8n integration guide ([3f1bec4](https://github.com/KochC/opencode-llm-proxy/commit/3f1bec4b0a30bfb60d2f0a37e23d088d3163cb66))
* disable stale bridge tool IDs from other pool slots ([ca3e552](https://github.com/KochC/opencode-llm-proxy/commit/ca3e552aa1b64def62ccd0c84cd31a61a8f3a3f9))
* disable stale bridge tool IDs from other pool slots ([a5ba31c](https://github.com/KochC/opencode-llm-proxy/commit/a5ba31cb3a796e80a98bee963c23afcf1b21e214))
* disable stale bridge tool IDs from other pool slots (closes [#55](https://github.com/KochC/opencode-llm-proxy/issues/55)) ([5d419cd](https://github.com/KochC/opencode-llm-proxy/commit/5d419cdd552f62cf5f1d2151f0719dc5643408a5))
* message.part.delta streaming, .info shape for tokens/finish, parts fallback for empty content ([1ce569b](https://github.com/KochC/opencode-llm-proxy/commit/1ce569bc738ca2699fe7829bb767746d179e1e75))
* read message.part.delta for streaming, .info shape for tokens/finish, parts fallback for content ([522663c](https://github.com/KochC/opencode-llm-proxy/commit/522663cebc1b0f6e36885511ee0bea1656bff667))

## [1.7.0](https://github.com/KochC/opencode-llm-proxy/compare/v1.6.1...v1.7.0) (2026-07-04)


### Features

* add tool/function calling support ([#52](https://github.com/KochC/opencode-llm-proxy/issues/52)) ([d01cf20](https://github.com/KochC/opencode-llm-proxy/commit/d01cf203c4d307c995283b24be752680398d02c8))


### Bug Fixes

* accept Anthropic system field as content-block array ([#47](https://github.com/KochC/opencode-llm-proxy/issues/47)) ([2eb182f](https://github.com/KochC/opencode-llm-proxy/commit/2eb182f9114d006ededd4a8d2556cb4f1917ef70)), closes [#46](https://github.com/KochC/opencode-llm-proxy/issues/46)
* Anthropic system content-block arrays, Responses API SSE spec compliance ([0811e1e](https://github.com/KochC/opencode-llm-proxy/commit/0811e1ea74d5e97552f5419561030924a9fd825a))
* emit content_part.done and populate output_text.done.text per Responses API spec ([#49](https://github.com/KochC/opencode-llm-proxy/issues/49)) ([b7402ca](https://github.com/KochC/opencode-llm-proxy/commit/b7402cabf22720087158e52d217c64978775ae6b)), closes [#48](https://github.com/KochC/opencode-llm-proxy/issues/48)

## [1.6.1](https://github.com/KochC/opencode-llm-proxy/compare/v1.6.0...v1.6.1) (2026-03-27)


### Bug Fixes

* reflect request Origin in CORS allow-origin for specific origin config ([f8da40a](https://github.com/KochC/opencode-llm-proxy/commit/f8da40a9628fa74e76c2dec069aa1f24c4eb6341))

## [1.6.0](https://github.com/KochC/opencode-llm-proxy/compare/v1.5.0...v1.6.0) (2026-03-27)


### Features

* add Anthropic Messages API and Google Gemini API endpoints ([#40](https://github.com/KochC/opencode-llm-proxy/issues/40)) ([c516686](https://github.com/KochC/opencode-llm-proxy/commit/c51668634e1a25ff0fd2fb21e9c9263f2f841535))

## [1.5.0](https://github.com/KochC/opencode-llm-proxy/compare/v1.4.0...v1.5.0) (2026-03-27)


### Features

* refactor SSE queue, expand test coverage, fix package metadata ([#36](https://github.com/KochC/opencode-llm-proxy/issues/36)) ([0d96582](https://github.com/KochC/opencode-llm-proxy/commit/0d96582456761ca62b3f59e65128fd7e4be77519))

## [1.4.0](https://github.com/KochC/opencode-llm-proxy/compare/v1.3.0...v1.4.0) (2026-03-27)


### Features

* implement SSE streaming and support all opencode providers ([d9f2662](https://github.com/KochC/opencode-llm-proxy/commit/d9f2662cf6c0d8119d185864acc826186ecf7c40))

## [1.3.0](https://github.com/KochC/opencode-llm-proxy/compare/v1.2.0...v1.3.0) (2026-03-27)


### Features

* expand tests, add ESLint, update README ([b15cb94](https://github.com/KochC/opencode-llm-proxy/commit/b15cb94b794ccb87ce0b99c32acce2cc496b5784))

## [1.2.0](https://github.com/KochC/opencode-llm-proxy/compare/v1.1.0...v1.2.0) (2026-03-27)


### Features

* initial release of opencode-openai-proxy plugin ([d5a9786](https://github.com/KochC/opencode-llm-proxy/commit/d5a97865bdb0b059f366aa7f75e48261a109bef4))


### Bug Fixes

* use plain v-prefix tags, match either tag format in publish ([444e1f2](https://github.com/KochC/opencode-llm-proxy/commit/444e1f2b4415a57c39408ed1ac8875f834186aa1))

## [1.1.0](https://github.com/KochC/opencode-llm-proxy/compare/opencode-llm-proxy-v1.0.0...opencode-llm-proxy-v1.1.0) (2026-03-27)


### Features

* initial release of opencode-openai-proxy plugin ([d5a9786](https://github.com/KochC/opencode-llm-proxy/commit/d5a97865bdb0b059f366aa7f75e48261a109bef4))
