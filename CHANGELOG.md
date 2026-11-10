# Changelog

## [1.12.1](https://github.com/KochC/opencode-llm-proxy/compare/v1.12.0...v1.12.1) (2026-11-10)


### Bug Fixes

* accept no-op generation controls and explain upstream failures ([f77a5e5](https://github.com/KochC/opencode-llm-proxy/commit/f77a5e598ce704d3fb71a39bd724c2c9f08ca559))
* accept no-op generation controls and explain upstream failures ([6b58270](https://github.com/KochC/opencode-llm-proxy/commit/6b58270b36b3f309ce5ba921e1a5d12e8375c06c))

## [1.12.0](https://github.com/KochC/opencode-llm-proxy/compare/v1.11.2...v1.12.0) (2026-11-10)


### Features

* add opt-in native tool passthrough for native OpenCode clients ([92ee68c](https://github.com/KochC/opencode-llm-proxy/commit/92ee68c14752bdaefe40e08b57e97a526d2958d7))
* opt-in native tool passthrough for native OpenCode clients ([38c3168](https://github.com/KochC/opencode-llm-proxy/commit/38c31681b1cb8d24c1d7cc99e8579d5336818f54))


### Bug Fixes

* delete throwaway sessions only after the turn settles (FOREIGN KEY race on aborted turns) ([070c42a](https://github.com/KochC/opencode-llm-proxy/commit/070c42a0c128145b63abed02366a90640c5e6d93))
* **deps:** override minimatch to 11.0.7 to clear the audit advisory ([cf113fa](https://github.com/KochC/opencode-llm-proxy/commit/cf113fa1c525f1a2e1db55ed05605f1332e01bc1))
* **deps:** override minimatch to 11.0.7 to clear the audit advisory ([7bcc116](https://github.com/KochC/opencode-llm-proxy/commit/7bcc116a929388fa8c309651f5223cb0a1394ded))
* enforce maximum-token controls (closes [#75](https://github.com/KochC/opencode-llm-proxy/issues/75)) ([0faebc8](https://github.com/KochC/opencode-llm-proxy/commit/0faebc849ab314e3d929a9504ebfed12ad08e2be))
* enforce maximum-token controls instead of only warning ([be1a338](https://github.com/KochC/opencode-llm-proxy/commit/be1a33854d11c22998b3fc2296ff3e2dade621d5))
* **lint:** satisfy current eslint config and document delete timeout ([b879d51](https://github.com/KochC/opencode-llm-proxy/commit/b879d51ae50da73b7a75eebcb8f0ac006bc557e4))
* map StructuredOutput finish to stop, not tool_calls ([38d742e](https://github.com/KochC/opencode-llm-proxy/commit/38d742e82806f85f6d163d40ea6cb6b9b6788d48))
* preserve structured tool payloads across API formats ([7ded05c](https://github.com/KochC/opencode-llm-proxy/commit/7ded05c271fd08237d95c2174251896b4d3860cf))
* preserve structured tool payloads across API formats ([09242fe](https://github.com/KochC/opencode-llm-proxy/commit/09242fedd94cde3a3ec332b4007fd83325a0d869)), closes [#93](https://github.com/KochC/opencode-llm-proxy/issues/93)
* stop Bun closing slow requests with "socket connection was closed unexpectedly" ([63495d1](https://github.com/KochC/opencode-llm-proxy/commit/63495d1daffe76b70e944b051e9c697fc71b4408))
* stop Bun closing slow requests with "socket connection was closed unexpectedly" ([2ad71ca](https://github.com/KochC/opencode-llm-proxy/commit/2ad71caab748b7d1747d3a757ef2e934b0032bce))
* warn once when unenforceable max-token controls are requested ([6e5516a](https://github.com/KochC/opencode-llm-proxy/commit/6e5516a6c61d5b061aa8cac998bdd7b9cd30e6cd)), closes [#75](https://github.com/KochC/opencode-llm-proxy/issues/75)

## [1.11.2](https://github.com/KochC/opencode-llm-proxy/compare/v1.11.1...v1.11.2) (2026-10-18)


### Bug Fixes

* normalize the package repository URL ([a61ebb7](https://github.com/KochC/opencode-llm-proxy/commit/a61ebb79958cd5346d24e473632458e5a40d5fa0))

## [1.11.1](https://github.com/KochC/opencode-llm-proxy/compare/v1.11.0...v1.11.1) (2026-10-18)


### Bug Fixes

* complete V2 turns when the OpenCode event stream is silent ([61695e5](https://github.com/KochC/opencode-llm-proxy/commit/61695e5e56fcad06bb3ce153066af384fc517330))
* complete V2 turns when the OpenCode event stream is silent ([8450c5b](https://github.com/KochC/opencode-llm-proxy/commit/8450c5b45f7c831bc46f9c65b7d760797d5756a3))
* stop agent turns hanging when the OpenCode event stream is silent ([83a506b](https://github.com/KochC/opencode-llm-proxy/commit/83a506b611ee571197cf01a96776d4a2ba14ce6b))
* stop agent turns hanging when the OpenCode event stream is silent ([2f945ae](https://github.com/KochC/opencode-llm-proxy/commit/2f945aee3cc68b9b945b860f1ff280b417e0aa3a))

## [1.11.0](https://github.com/KochC/opencode-llm-proxy/compare/v1.10.0...v1.11.0) (2026-10-17)


### Features

* support the OpenCode V2 plugin API ([16ce1a5](https://github.com/KochC/opencode-llm-proxy/commit/16ce1a534c0d10eb509b2f0a633cca32f50a611a))
* support the OpenCode V2 plugin API ([1fee24a](https://github.com/KochC/opencode-llm-proxy/commit/1fee24a1ed558742dc6e144f75dfd15bb8717ddb))


### Bug Fixes

* **plugin:** add V1 default export descriptor to stop legacy loader probing every helper ([8c262c4](https://github.com/KochC/opencode-llm-proxy/commit/8c262c440c5b3864089281be5b97a06ba35d5312))
* **plugin:** add V1 default export descriptor to stop legacy loader probing every helper ([d0ba94e](https://github.com/KochC/opencode-llm-proxy/commit/d0ba94e0ce5bc5d572eda9934258a2baff457b41)), closes [#86](https://github.com/KochC/opencode-llm-proxy/issues/86)

## [1.10.0](https://github.com/KochC/opencode-llm-proxy/compare/v1.9.0...v1.10.0) (2026-07-31)


### Features

* complete proxy reliability and observability ([9f416eb](https://github.com/KochC/opencode-llm-proxy/commit/9f416eb1970deb114ce9b960dabb38da9efabd45))
* complete proxy reliability and observability ([163bf86](https://github.com/KochC/opencode-llm-proxy/commit/163bf86ea9418011426c9c142d887d70dbe02506))
* harden and extend the LLM proxy ([#79](https://github.com/KochC/opencode-llm-proxy/issues/79)) ([855880e](https://github.com/KochC/opencode-llm-proxy/commit/855880e869ed8c502f6d86119853c2188dd5fc0e))


### Bug Fixes

* use public registry URLs in lockfile ([841d850](https://github.com/KochC/opencode-llm-proxy/commit/841d850397dda62a49e97c85c5f9fe9a001947be))

## [1.9.0](https://github.com/KochC/opencode-llm-proxy/compare/v1.8.0...v1.9.0) (2026-07-10)


### Features

* parallel tool calls + integration docs ([#70](https://github.com/KochC/opencode-llm-proxy/issues/70)) ([03467c0](https://github.com/KochC/opencode-llm-proxy/commit/03467c0b3a488e64f15938aa0aab350f647fc53d))

## [1.8.0](https://github.com/KochC/opencode-llm-proxy/compare/v1.7.1...v1.8.0) (2026-07-09)


### Features

* parallel tool calls across OpenAI, Anthropic, and Gemini APIs ([#62](https://github.com/KochC/opencode-llm-proxy/issues/62)) ([8dfdb25](https://github.com/KochC/opencode-llm-proxy/commit/8dfdb254134d146d095933fa5675e6d0e24ac09d))

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
