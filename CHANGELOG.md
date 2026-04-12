# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.6.25](https://github.com/taverns-red/speech-evaluator/compare/ai-speech-evaluator-v0.6.24...ai-speech-evaluator-v0.6.25) (2026-04-12)


### Features

* add Clerk user ID to GCS evaluation path ([#195](https://github.com/taverns-red/speech-evaluator/issues/195)) ([6a5098b](https://github.com/taverns-red/speech-evaluator/commit/6a5098b5ecd5f559666e2871979f0f8c99e1b2bf))
* add GA4 analytics with unified taverns.red property ([#172](https://github.com/taverns-red/speech-evaluator/issues/172)) ([15c5bec](https://github.com/taverns-red/speech-evaluator/commit/15c5becdab25fbf0a2c37b4d6cd26e9c5474970a))
* add meeting agenda types and PDF parser endpoint ([#174](https://github.com/taverns-red/speech-evaluator/issues/174)) ([20ff963](https://github.com/taverns-red/speech-evaluator/commit/20ff963df780909aa6a943dc0919e70a25f0d1db))
* add meeting mode UI with agenda panel and meeting consent ([#174](https://github.com/taverns-red/speech-evaluator/issues/174), [#175](https://github.com/taverns-red/speech-evaluator/issues/175)) ([592f535](https://github.com/taverns-red/speech-evaluator/commit/592f53513533b221f02aa79d5cf1d4f2c845346c))
* add Playwright e2e tests for frontend ([#167](https://github.com/taverns-red/speech-evaluator/issues/167)) ([0a61de2](https://github.com/taverns-red/speech-evaluator/commit/0a61de2f7601ebb28ad58995f98f26fdaf660209))
* declutter IDLE state and auto-scroll to evaluation ([#180](https://github.com/taverns-red/speech-evaluator/issues/180), [#181](https://github.com/taverns-red/speech-evaluator/issues/181)) ([c0d7ee2](https://github.com/taverns-red/speech-evaluator/commit/c0d7ee2ea900feb4600b107e32da53b3c8029f14))
* deep link URL parameters for Red Club integration ([#196](https://github.com/taverns-red/speech-evaluator/issues/196)) ([1c56399](https://github.com/taverns-red/speech-evaluator/commit/1c56399b4a67639b393663df9d253f30549457fb))
* download buttons on share page — evaluation, transcript, audio ([#188](https://github.com/taverns-red/speech-evaluator/issues/188)) ([1fbb6af](https://github.com/taverns-red/speech-evaluator/commit/1fbb6afb791a7836a93fa78195bf2976f88f059a))
* history shows all evaluations for authenticated user ([#184](https://github.com/taverns-red/speech-evaluator/issues/184)) ([d081567](https://github.com/taverns-red/speech-evaluator/commit/d0815679a30d606cc370fce44a7ecb5421d22b38))
* meeting export, share links, and retention sweep ([#177](https://github.com/taverns-red/speech-evaluator/issues/177)) ([d5025ee](https://github.com/taverns-red/speech-evaluator/commit/d5025eefae9e18c4663afcca89b3b38aa1ff512c))
* meeting grouping with GCS persistence and history playback ([#176](https://github.com/taverns-red/speech-evaluator/issues/176)) ([55c0bd8](https://github.com/taverns-red/speech-evaluator/commit/55c0bd891cd167935e03d45b7fabc6158cf4c503))
* mobile-first sticky bar — contextual primary actions ([#183](https://github.com/taverns-red/speech-evaluator/issues/183)) ([2cd2752](https://github.com/taverns-red/speech-evaluator/commit/2cd27526fa19ba6cc67779dfe53d5fb0ccb61a0e))
* re-evaluate endpoint and history UI button ([#187](https://github.com/taverns-red/speech-evaluator/issues/187)) ([c79c7eb](https://github.com/taverns-red/speech-evaluator/commit/c79c7ebc5748b9d9762b46acac713cc5aa28dd12))
* redesign share page with audio playback, OG tags, and CTA ([#179](https://github.com/taverns-red/speech-evaluator/issues/179)) ([5a56125](https://github.com/taverns-red/speech-evaluator/commit/5a561258d32199ea420263a380eb730044351878))
* replace emoji icons with inline SVG icon system ([#182](https://github.com/taverns-red/speech-evaluator/issues/182)) ([8c3f236](https://github.com/taverns-red/speech-evaluator/commit/8c3f236bae409aff11fde60c762e5a6dcc82d79e))
* respect OS light/dark theme on share and login pages ([#185](https://github.com/taverns-red/speech-evaluator/issues/185)) ([e860d68](https://github.com/taverns-red/speech-evaluator/commit/e860d682bbd7847520189a840e9bdc8b0bad3750))
* save original speech audio to GCS for re-evaluation ([#187](https://github.com/taverns-red/speech-evaluator/issues/187)) ([cb26322](https://github.com/taverns-red/speech-evaluator/commit/cb26322994f5d879b337085d9ff3674db4c9da10))


### Bug Fixes

* add /js/ and static assets to auth bypass — entire app was broken ([#165](https://github.com/taverns-red/speech-evaluator/issues/165)) ([518488f](https://github.com/taverns-red/speech-evaluator/commit/518488fa99416a3f962eb6f39efac085093b8cdd))
* add 5-minute clockSkewInMs to Clerk JWT verification ([#165](https://github.com/taverns-red/speech-evaluator/issues/165)) ([154d8bc](https://github.com/taverns-red/speech-evaluator/commit/154d8bc0ac96e77e0c1991a2f4bb9e6f98d9ffe4))
* add missing checkVadEnergyFallback import in audio.js ([#165](https://github.com/taverns-red/speech-evaluator/issues/165)) ([99ec10e](https://github.com/taverns-red/speech-evaluator/commit/99ec10e1ee64483377ebde344458107cc44d2ef5))
* await WebSocket close handshake in test teardown ([#169](https://github.com/taverns-red/speech-evaluator/issues/169)) ([add144b](https://github.com/taverns-red/speech-evaluator/commit/add144b9aa21bd43badd8ae7d00c030cf866fbc3))
* cache-bust audio-worklet.js to clear stale auth HTML cache ([#165](https://github.com/taverns-red/speech-evaluator/issues/165)) ([d662cd1](https://github.com/taverns-red/speech-evaluator/commit/d662cd1085bcad57105609f6ca09de7940b12867))
* duplicate escapeHtml crashed JS init, breaking E2E tests ([#174](https://github.com/taverns-red/speech-evaluator/issues/174)) ([faa8bcf](https://github.com/taverns-red/speech-evaluator/commit/faa8bcfa46a9eb7b368599dd160539b339791f55))
* export 500 from Express 5 wildcard comma-join + metrics download ([#193](https://github.com/taverns-red/speech-evaluator/issues/193)) ([446e45b](https://github.com/taverns-red/speech-evaluator/commit/446e45bf55fc444614c5bbad04e76a117966961f))
* increase Clerk JWT clockSkew to 24h for WS auth ([#165](https://github.com/taverns-red/speech-evaluator/issues/165)) ([20c7170](https://github.com/taverns-red/speech-evaluator/commit/20c7170505037f6ee29d07ebfbce2b89624b9543))
* load Clerk SDK on main page to keep __session fresh ([#165](https://github.com/taverns-red/speech-evaluator/issues/165)) ([6c0176a](https://github.com/taverns-red/speech-evaluator/commit/6c0176ad5234b314d1d7d1be76c81944a041af16))
* non-classic evaluation styles fail shape invariant ([#194](https://github.com/taverns-red/speech-evaluator/issues/194)) ([2d00501](https://github.com/taverns-red/speech-evaluator/commit/2d005015b6cce03fd8a5e329fb0222661519ee15))
* persist live session evaluations to GCS history ([#168](https://github.com/taverns-red/speech-evaluator/issues/168)) ([bf512f0](https://github.com/taverns-red/speech-evaluator/commit/bf512f070f0eefaf05f25e60689acdf9b99eea25))
* re-evaluate fails on large metrics + replace prompt with dropdown ([#193](https://github.com/taverns-red/speech-evaluator/issues/193)) ([f1b2d91](https://github.com/taverns-red/speech-evaluator/commit/f1b2d9199f9475c2cb59e74fc7cd39c7926f1f63))
* re-evaluate UI after restoring consent from localStorage ([#165](https://github.com/taverns-red/speech-evaluator/issues/165)) ([d2e976e](https://github.com/taverns-red/speech-evaluator/commit/d2e976ec35d4f2a4c6e09419b89d6b7a132f4dbb))
* re-trigger consent state after reload in E2E test ([#170](https://github.com/taverns-red/speech-evaluator/issues/170)) ([c889a9e](https://github.com/taverns-red/speech-evaluator/commit/c889a9e10d2a93cef6b2f62f7e98c07f44cd2e7f))
* replace deprecated apple-mobile-web-app-capable meta tag ([0bf76aa](https://github.com/taverns-red/speech-evaluator/commit/0bf76aa151fa0794b91cd0576f945ea35e5ff9eb))
* replace emoji with SVG icons in history actions, fix broken textContent ([#182](https://github.com/taverns-red/speech-evaluator/issues/182)) ([434de06](https://github.com/taverns-red/speech-evaluator/commit/434de067e1ebdf73a60f3aca5736d1240aa07f00))
* set RECORDING state before starting AudioWorklet ([#165](https://github.com/taverns-red/speech-evaluator/issues/165)) ([a0a7dff](https://github.com/taverns-red/speech-evaluator/commit/a0a7dffb5f17493a9c534bae901150857f5dc592))
* share API missing express.json() — req.body undefined ([#178](https://github.com/taverns-red/speech-evaluator/issues/178)) ([7bb6139](https://github.com/taverns-red/speech-evaluator/commit/7bb6139caa70b818d7f833d3d4c75508d5f04669))
* share pages crash on missing files and non-string values ([#178](https://github.com/taverns-red/speech-evaluator/issues/178)) ([0a36739](https://github.com/taverns-red/speech-evaluator/commit/0a367395ce55414abd0e686a89241b3899dd9e2d))
* stabilize flaky E2E consent test + CI cleanup ([#170](https://github.com/taverns-red/speech-evaluator/issues/170)) ([51cda85](https://github.com/taverns-red/speech-evaluator/commit/51cda85b05e89c72892e83793b3a6015a7ade09a))
* strip pitchProfile and paceVariation from re-evaluate metrics ([#193](https://github.com/taverns-red/speech-evaluator/issues/193)) ([632cf55](https://github.com/taverns-red/speech-evaluator/commit/632cf55d55499442daba706805433a557dea7cc0))
* switch to whisper-1 for timestamps and change default time limit to 180s ([#186](https://github.com/taverns-red/speech-evaluator/issues/186), [#189](https://github.com/taverns-red/speech-evaluator/issues/189)) ([08e2ad9](https://github.com/taverns-red/speech-evaluator/commit/08e2ad91ac137b21b1085d07c66cd96389c7048a))
* use Express 5 named wildcard {*path} for export route ([#165](https://github.com/taverns-red/speech-evaluator/issues/165)) ([7bfe1ab](https://github.com/taverns-red/speech-evaluator/commit/7bfe1abfaf8c9db05ab19082a7e4265b336bfe2b))

## [0.6.24](https://github.com/taverns-red/speech-evaluator/compare/ai-speech-evaluator-v0.6.23...ai-speech-evaluator-v0.6.24) (2026-03-22)


### Features

* add GET /api/me endpoint for user profile display ([#162](https://github.com/taverns-red/speech-evaluator/issues/162)) ([3e85bd0](https://github.com/taverns-red/speech-evaluator/commit/3e85bd004b07f6d7f0edb550ef5be1a6fef71fd2))
* add Markdown evaluation export with /api/export endpoint and history button ([#164](https://github.com/taverns-red/speech-evaluator/issues/164)) ([e83d2e7](https://github.com/taverns-red/speech-evaluator/commit/e83d2e7d5f6216f02a09a422632ec94390e4958f))
* add operator notes — live textarea injected into evaluation prompt ([#164](https://github.com/taverns-red/speech-evaluator/issues/164)) ([f9c0729](https://github.com/taverns-red/speech-evaluator/commit/f9c0729635bb2e7528bb743cfbace0bf10b2df5c))
* add shareable evaluation links with public share page ([#164](https://github.com/taverns-red/speech-evaluator/issues/164)) ([0f42358](https://github.com/taverns-red/speech-evaluator/commit/0f42358d8069ed9f395c2b6b3bd7613a1faac7e5))
* auto-populate speaker name from signed-in Clerk user ([#163](https://github.com/taverns-red/speech-evaluator/issues/163)) ([7999cdb](https://github.com/taverns-red/speech-evaluator/commit/7999cdb9983edeb27372e6a9dae7e05a6ac17bfd))
* migrate from Firebase Auth to Clerk ([#158](https://github.com/taverns-red/speech-evaluator/issues/158)) ([e858bfe](https://github.com/taverns-red/speech-evaluator/commit/e858bfe65ab5b42cd997cac62fc7289c57be1960))
* rewrite login page with Clerk sign-in component ([#158](https://github.com/taverns-red/speech-evaluator/issues/158)) ([710f033](https://github.com/taverns-red/speech-evaluator/commit/710f0330a8a1a5301b5d0bedd9f2d91d954b74b4))
* speaker diarization — multi-speaker labels in transcript ([#157](https://github.com/taverns-red/speech-evaluator/issues/157)) ([e7d9f73](https://github.com/taverns-red/speech-evaluator/commit/e7d9f73489918e2da5d915c744105fd19eef9c32))


### Bug Fixes

* mount sign-up component on our domain instead of redirecting to Clerk hosted page ([#158](https://github.com/taverns-red/speech-evaluator/issues/158)) ([e85a975](https://github.com/taverns-red/speech-evaluator/commit/e85a97509d5e8c0f162fe2523d94ab1b959f34c3))
* pin trivy-action to 0.35.0 (supply chain attack on earlier tags) ([#160](https://github.com/taverns-red/speech-evaluator/issues/160)) ([51e36d5](https://github.com/taverns-red/speech-evaluator/commit/51e36d5207efb5d0c5badbce4866e7512d9471a7))
* re-send consent + session config on WebSocket reconnect ([#165](https://github.com/taverns-red/speech-evaluator/issues/165)) ([673df43](https://github.com/taverns-red/speech-evaluator/commit/673df43211d2217a277f7de419551e892c07cd83))
* remove double card wrapper on login page ([#158](https://github.com/taverns-red/speech-evaluator/issues/158)) ([7b463a8](https://github.com/taverns-red/speech-evaluator/commit/7b463a8129f78617d30e0dfa2d29e0304b7ba10f))
* strip trailing $ from decoded Clerk host in login.js ([#158](https://github.com/taverns-red/speech-evaluator/issues/158)) ([3f42ab6](https://github.com/taverns-red/speech-evaluator/commit/3f42ab64529f7b133a6eef2e53fbc751a3da343f))
* use Clerk auto-instantiated window.Clerk instead of constructor ([#158](https://github.com/taverns-red/speech-evaluator/issues/158)) ([a40d2f3](https://github.com/taverns-red/speech-evaluator/commit/a40d2f3c7f7091c1bbdf88bbd7a04de44e8fec43))

## [0.6.23](https://github.com/taverns-red/speech-evaluator/compare/ai-speech-evaluator-v0.6.22...ai-speech-evaluator-v0.6.23) (2026-03-21)


### Features

* 5 new feedback styles — EEC, Radical Candour, Socratic, Comparative, Micro-Focus ([#149](https://github.com/taverns-red/speech-evaluator/issues/149)) ([636ddb3](https://github.com/taverns-red/speech-evaluator/commit/636ddb3a86a226b13c4d2f2fd484c3e7d27da528))
* coaching cues module — pure logic + 16 TDD tests ([#155](https://github.com/taverns-red/speech-evaluator/issues/155)) ([8cdbfc6](https://github.com/taverns-red/speech-evaluator/commit/8cdbfc69fb4ef0e2582bd8f768d4022acc0cb673))
* comparative evaluation analytics — side-by-side view ([#154](https://github.com/taverns-red/speech-evaluator/issues/154)) ([6bddd8f](https://github.com/taverns-red/speech-evaluator/commit/6bddd8f36aa82c82037de5a1c6a829dc8221797d))
* first-run setup wizard with multi-step modal ([#156](https://github.com/taverns-red/speech-evaluator/issues/156)) ([3f3025d](https://github.com/taverns-red/speech-evaluator/commit/3f3025d4eb6c4eda7f6a8e5836f3d8c29ad80ff8))
* goals panel — API endpoints + frontend rendering ([#153](https://github.com/taverns-red/speech-evaluator/issues/153)) ([bcdd06a](https://github.com/taverns-red/speech-evaluator/commit/bcdd06a60d03326199f04f131de2e6cf0326cdd1))
* speaker goal setting module with CRUD + evaluation logic ([#153](https://github.com/taverns-red/speech-evaluator/issues/153)) ([bde9b9a](https://github.com/taverns-red/speech-evaluator/commit/bde9b9a23d3f5c01e037fc85f7cdab0f3d230559))
* svg radar chart for category scores ([#151](https://github.com/taverns-red/speech-evaluator/issues/151)) ([8ad5d29](https://github.com/taverns-red/speech-evaluator/commit/8ad5d292967e1dfe33f2c77217bac7fd61a499e9))
* wire coaching cues end-to-end — server timer + WS handler + toast UI ([#155](https://github.com/taverns-red/speech-evaluator/issues/155)) ([d9acad4](https://github.com/taverns-red/speech-evaluator/commit/d9acad4526373d8245d4cc3d9cc567357f9b4c53))

## [0.6.22](https://github.com/taverns-red/speech-evaluator/compare/ai-speech-evaluator-v0.6.21...ai-speech-evaluator-v0.6.22) (2026-03-21)


### Features

* habit detection with patterns card in history tab ([#147](https://github.com/taverns-red/speech-evaluator/issues/147)) ([cbb5202](https://github.com/taverns-red/speech-evaluator/commit/cbb52025160b1e8eb150e3de3a33c5703166bcc1))
* practice mode for solo speech rehearsal ([#146](https://github.com/taverns-red/speech-evaluator/issues/146)) ([b3b43a5](https://github.com/taverns-red/speech-evaluator/commit/b3b43a549833fdfecc6a281c8f68ee8b8929282e))

## [0.6.21](https://github.com/taverns-red/speech-evaluator/compare/ai-speech-evaluator-v0.6.20...ai-speech-evaluator-v0.6.21) (2026-03-21)


### Features

* add category score breakdowns backend — type, prompt, parser, golden tests ([#144](https://github.com/taverns-red/speech-evaluator/issues/144)) ([09056b3](https://github.com/taverns-red/speech-evaluator/commit/09056b30d49825c7034ddf87d21beaf7b317ad75))
* category score bar chart in live + history UI ([#144](https://github.com/taverns-red/speech-evaluator/issues/144)) ([044e74b](https://github.com/taverns-red/speech-evaluator/commit/044e74b1af9f91097b6ae7eadb7ff1c207adb6a5))
* collapsible config sections + sticky action bar ([#137](https://github.com/taverns-red/speech-evaluator/issues/137)) ([9f3cd43](https://github.com/taverns-red/speech-evaluator/commit/9f3cd437fe4fbe5e1a441ab1cd7a63289b4b684c))
* deepgram websocket auto-reconnect with audio buffering ([#139](https://github.com/taverns-red/speech-evaluator/issues/139)) ([4e07d28](https://github.com/taverns-red/speech-evaluator/commit/4e07d285ae05bc55f2720e3e529db113d3ad0074))
* improved history empty state with progress tracking prompt ([#140](https://github.com/taverns-red/speech-evaluator/issues/140)) ([31134d1](https://github.com/taverns-red/speech-evaluator/commit/31134d165d96defad8bbdc00a8949434f6eac345))
* personalized improvement plans with score aggregation + LLM exercises ([#145](https://github.com/taverns-red/speech-evaluator/issues/145)) ([174269e](https://github.com/taverns-red/speech-evaluator/commit/174269e97c3bd603f02863b1c9ca3e91d1358fda))
* progress trend chart with SVG sparklines in history tab ([#140](https://github.com/taverns-red/speech-evaluator/issues/140)) ([9571bf6](https://github.com/taverns-red/speech-evaluator/commit/9571bf613dee6e6e5a57b127bcca4cfa2ed2cc73))
* responsive CSS for tablet and phone viewports ([#139](https://github.com/taverns-red/speech-evaluator/issues/139)) ([5931310](https://github.com/taverns-red/speech-evaluator/commit/5931310ce7e624f66a8cd81debd7bf5a0442e9ea))
* speaker progress API with getProgressData and endpoint ([#140](https://github.com/taverns-red/speech-evaluator/issues/140)) ([445444a](https://github.com/taverns-red/speech-evaluator/commit/445444ac3b53d223c80b5b3ef5228e72b888def2))

## [0.6.20](https://github.com/taverns-red/speech-evaluator/compare/ai-speech-evaluator-v0.6.19...ai-speech-evaluator-v0.6.20) (2026-03-21)


### Features

* style-aware rendering and server validation ([#135](https://github.com/taverns-red/speech-evaluator/issues/135)) ([6e6186d](https://github.com/taverns-red/speech-evaluator/commit/6e6186d833be67f9cdd938db270361d0618531ad))

## [0.6.19](https://github.com/taverns-red/speech-evaluator/compare/ai-speech-evaluator-v0.6.18...ai-speech-evaluator-v0.6.19) (2026-03-21)


### Features

* add evaluation style prompts and threading ([#133](https://github.com/taverns-red/speech-evaluator/issues/133)) ([5a7e0d1](https://github.com/taverns-red/speech-evaluator/commit/5a7e0d1a0546c7c91bad50997238d57ba3bce688))
* add EvaluationStyle enum and style-specific item types ([#133](https://github.com/taverns-red/speech-evaluator/issues/133)) ([370528e](https://github.com/taverns-red/speech-evaluator/commit/370528ee2dc0ad5afe0d1dcd806bd5df4b06ff2b))
* add product spec and PM skill reference ([#130](https://github.com/taverns-red/speech-evaluator/issues/130)) ([59565a3](https://github.com/taverns-red/speech-evaluator/commit/59565a3006e86dac91cd7c049415e258f7dd66de))
* wire evaluation style selector through full stack ([#133](https://github.com/taverns-red/speech-evaluator/issues/133)) ([c2b0fc2](https://github.com/taverns-red/speech-evaluator/commit/c2b0fc2bb1f646089b4f4ada3af534b0b64d284a))


### Bug Fixes

* add missing capabilities field to VisualObservations test fixtures ([113f6f5](https://github.com/taverns-red/speech-evaluator/commit/113f6f5ff4b7099b4c72e58e97ac6bbcfd21c419))

## [0.6.18](https://github.com/taverns-red/speech-evaluator/compare/ai-speech-evaluator-v0.6.17...ai-speech-evaluator-v0.6.18) (2026-03-21)


### Features

* add GCS data retention sweep and lesson 39 ([#130](https://github.com/taverns-red/speech-evaluator/issues/130)) ([10eb122](https://github.com/taverns-red/speech-evaluator/commit/10eb12254ae944386bd4c704f9563a72a387121a))
* extract objectives from evaluation form in LLM prompt ([#131](https://github.com/taverns-red/speech-evaluator/issues/131)) ([7e80cec](https://github.com/taverns-red/speech-evaluator/commit/7e80cec123eb8916e42a2130e323aad998b5be54))
* thread analysisTier/visionFrameCount through upload handler to GCS ([#130](https://github.com/taverns-red/speech-evaluator/issues/130)) ([9c14b0d](https://github.com/taverns-red/speech-evaluator/commit/9c14b0d76503ddcc56b07a3992a1fe399368efd6))

## [0.6.17](https://github.com/taverns-red/speech-evaluator/compare/ai-speech-evaluator-v0.6.16...ai-speech-evaluator-v0.6.17) (2026-03-21)


### Features

* add evaluation deletion API and UI ([#128](https://github.com/taverns-red/speech-evaluator/issues/128)) ([4cee365](https://github.com/taverns-red/speech-evaluator/commit/4cee3659e40d984b402838442cb01b3a772340c0))
* add live-mode Vision frame capture via WebSocket ([#128](https://github.com/taverns-red/speech-evaluator/issues/128)) ([fff200a](https://github.com/taverns-red/speech-evaluator/commit/fff200a178c0411218368e4cdf64d0754907bb39))
* add privacy notice, delete button CSS, and cost metadata ([#128](https://github.com/taverns-red/speech-evaluator/issues/128)) ([c9c7359](https://github.com/taverns-red/speech-evaluator/commit/c9c73594273c342ef5c34c96cf6999b768284100))

## [0.6.16](https://github.com/taverns-red/speech-evaluator/compare/ai-speech-evaluator-v0.6.15...ai-speech-evaluator-v0.6.16) (2026-03-20)


### Features

* add analysis tier selector UI + backend plumbing ([#125](https://github.com/taverns-red/speech-evaluator/issues/125)) ([30b17e8](https://github.com/taverns-red/speech-evaluator/commit/30b17e8c9f4d08623f2b2a7300a0d31e10e913b0))
* add analysis tiers module with config and cost estimation ([#125](https://github.com/taverns-red/speech-evaluator/issues/125)) ([dcfde8b](https://github.com/taverns-red/speech-evaluator/commit/dcfde8b491d2279f29626ab0625a60c631899c44))
* add cost guardrails — tier cost display + upload analysisTier ([#125](https://github.com/taverns-red/speech-evaluator/issues/125)) ([2cf44c4](https://github.com/taverns-red/speech-evaluator/commit/2cf44c48511a63338bff3c68d2de481bdb5252c1))
* add frame extractor with DI interface for upload-mode Vision ([#125](https://github.com/taverns-red/speech-evaluator/issues/125)) ([af68b45](https://github.com/taverns-red/speech-evaluator/commit/af68b4504f84bc1b4589f2e2f8722179a53182eb))
* integrate Vision frame extraction into upload evaluation pipeline ([#125](https://github.com/taverns-red/speech-evaluator/issues/125)) ([28df491](https://github.com/taverns-red/speech-evaluator/commit/28df49123daf52342aa05da882e51a43ab59bf43))

## [0.6.15](https://github.com/taverns-red/speech-evaluator/compare/ai-speech-evaluator-v0.6.14...ai-speech-evaluator-v0.6.15) (2026-03-20)


### Features

* add acoustic analysis — pitch, pace variation, prosodic indicators ([#124](https://github.com/taverns-red/speech-evaluator/issues/124)) ([09de6e1](https://github.com/taverns-red/speech-evaluator/commit/09de6e18b320079a99d3717e8caf5a7ae3b4173b))
* add frontend history tab with list, expand, and playback ([#123](https://github.com/taverns-red/speech-evaluator/issues/123)) ([68bce70](https://github.com/taverns-red/speech-evaluator/commit/68bce7092b3e40dfd9f480b0e6b68ff655a33cdf))
* add GCS history service with save/list/sign + backend API ([#123](https://github.com/taverns-red/speech-evaluator/issues/123)) ([93a87d1](https://github.com/taverns-red/speech-evaluator/commit/93a87d118a016346303792904ce0feb512f930d8))

## [0.6.14](https://github.com/taverns-red/speech-evaluator/compare/ai-speech-evaluator-v0.6.13...ai-speech-evaluator-v0.6.14) (2026-03-20)


### Features

* add API call tracking for Deepgram and OpenAI ([#118](https://github.com/taverns-red/speech-evaluator/issues/118)) ([bdfb494](https://github.com/taverns-red/speech-evaluator/commit/bdfb494fd9f2cfb31effdd6976ce0a0be1e605cb))
* add graceful shutdown with SIGTERM/SIGINT handling ([#118](https://github.com/taverns-red/speech-evaluator/issues/118)) ([682eb97](https://github.com/taverns-red/speech-evaluator/commit/682eb978b27f5ecaf2d623e7b08d2f9d8b70ec9f))
* add in-memory metrics collector ([#118](https://github.com/taverns-red/speech-evaluator/issues/118)) ([ad56bcc](https://github.com/taverns-red/speech-evaluator/commit/ad56bcc7e52eeeb6e257bdb35439cd6dd1e40e80))
* add request timeout middleware ([#118](https://github.com/taverns-red/speech-evaluator/issues/118)) ([87bf17a](https://github.com/taverns-red/speech-evaluator/commit/87bf17a40ec30e8209235e98fd36dddf029d8a19))
* add retry utility with exponential backoff ([#118](https://github.com/taverns-red/speech-evaluator/issues/118)) ([5b0e899](https://github.com/taverns-red/speech-evaluator/commit/5b0e89985779a6758dce3c5341262a348ad30e03))
* add structured JSON logger module ([#118](https://github.com/taverns-red/speech-evaluator/issues/118)) ([f310908](https://github.com/taverns-red/speech-evaluator/commit/f31090856bf47ad9126b6de07dec45964cbafb84))
* instrument MetricsCollector across pipeline ([#118](https://github.com/taverns-red/speech-evaluator/issues/118)) ([90d7ece](https://github.com/taverns-red/speech-evaluator/commit/90d7ece4c3cd94d89c88faf7d1a61dd30a06e3c0))
* wire structured logging across codebase, add health/metrics endpoints ([#118](https://github.com/taverns-red/speech-evaluator/issues/118)) ([3bd4c2a](https://github.com/taverns-red/speech-evaluator/commit/3bd4c2a5669221ba504781002c7c80ce893016b1))
* wrap API calls in withRetry() for transient error resilience ([#118](https://github.com/taverns-red/speech-evaluator/issues/118)) ([afb8ea5](https://github.com/taverns-red/speech-evaluator/commit/afb8ea560faa006b5b4285afb6ef145b3aa6b01f))


### Bug Fixes

* add missing buildZip import to upload.js (Closes [#120](https://github.com/taverns-red/speech-evaluator/issues/120)) ([c8f7e90](https://github.com/taverns-red/speech-evaluator/commit/c8f7e90b8bc0f27745c66c45ef11cc9931d66381))
* add missing STATUS_TEXT and stopVideoCapture imports to audio.js ([#121](https://github.com/taverns-red/speech-evaluator/issues/121)) ([7c82f2e](https://github.com/taverns-red/speech-evaluator/commit/7c82f2eb20ba9c7c53b6b9ff9c3ef6301a9316f4))
* **ci:** correct Artifact Registry auth region to northamerica-northeast1 ([a0bc461](https://github.com/taverns-red/speech-evaluator/commit/a0bc461604892c5bf9458548ac2bca95c465ee47))
* iOS Safari login fails with 'missing initial state' ([#111](https://github.com/taverns-red/speech-evaluator/issues/111)) ([53fddf8](https://github.com/taverns-red/speech-evaluator/commit/53fddf82ed332057ddb3039de60873bd72aae226))
* speed/ETA stuck on Calculating — throttle XHR progress samples ([#105](https://github.com/taverns-red/speech-evaluator/issues/105)) ([716a8b0](https://github.com/taverns-red/speech-evaluator/commit/716a8b07ee8004f584151400d71ae5853817a8e1))
* use co-located GCS bucket in northamerica-northeast1 ([#121](https://github.com/taverns-red/speech-evaluator/issues/121)) ([7a11413](https://github.com/taverns-red/speech-evaluator/commit/7a114136f5744189004840bd915764ca1465fa38))

## [0.6.13](https://github.com/rservant/speech-evaluator/compare/ai-speech-evaluator-v0.6.12...ai-speech-evaluator-v0.6.13) (2026-03-15)


### Bug Fixes

* speed/ETA shows Calculating... immediately, reduced min delta to 0.2s ([#105](https://github.com/rservant/speech-evaluator/issues/105)) ([e68035f](https://github.com/rservant/speech-evaluator/commit/e68035ff9b631400184b2371d6f4755db87fefba))

## [0.6.12](https://github.com/rservant/speech-evaluator/compare/ai-speech-evaluator-v0.6.11...ai-speech-evaluator-v0.6.12) (2026-03-15)


### Features

* accept uploaded evaluation forms to guide evaluation ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([0755950](https://github.com/rservant/speech-evaluator/commit/0755950a63a8897c70ba0b7b2ecee349a8a7cca9))
* add AI Ah-Counter role — first meeting role implementation ([#73](https://github.com/rservant/speech-evaluator/issues/73)) ([58ce18e](https://github.com/rservant/speech-evaluator/commit/58ce18e9e9848404767d477b333fd9ece39316bc))
* add camera flip button for mobile front/rear camera switching ([#51](https://github.com/rservant/speech-evaluator/issues/51)) ([a46190f](https://github.com/rservant/speech-evaluator/commit/a46190ff3043338906d93aa788aa6a67051a3274))
* add CI/CD deploy job to GitHub Actions workflow ([#36](https://github.com/rservant/speech-evaluator/issues/36)) ([891c1b1](https://github.com/rservant/speech-evaluator/commit/891c1b1a7dc20d1dd648d2b72add6874155de145))
* add download evaluation button to upload flow ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([9eba51e](https://github.com/rservant/speech-evaluator/commit/9eba51ef7300abb3147116a630a392a7ec6456bb))
* add Firebase Auth with email allowlist ([#37](https://github.com/rservant/speech-evaluator/issues/37)) ([aedcc3c](https://github.com/rservant/speech-evaluator/commit/aedcc3c79c701bb1ee31e15fcd73092e6c187750))
* add GCS signed URL uploads for large video files ([#66](https://github.com/rservant/speech-evaluator/issues/66)) ([27c9186](https://github.com/rservant/speech-evaluator/commit/27c9186f4bf029f7f62a8622624a683fcd8ff8d9))
* add General Evaluator role — meeting-level meta-evaluation ([#78](https://github.com/rservant/speech-evaluator/issues/78)) ([438b441](https://github.com/rservant/speech-evaluator/commit/438b4412692c911f9c240d97880d2dfaf91b69ae))
* add Grammarian role — LLM-based grammar analysis with fallback ([#75](https://github.com/rservant/speech-evaluator/issues/75)) ([5be59f3](https://github.com/rservant/speech-evaluator/commit/5be59f3cc80f2b2cfa9d674268326a7cf421fa34))
* Add iMessage notification workflow and remove outdated macOS native skill documentation. ([1fffcdd](https://github.com/rservant/speech-evaluator/commit/1fffcdd29ca891e52358cd1a5c11b7119fd56dc0))
* add light/dark theme toggle with localStorage persistence ([#56](https://github.com/rservant/speech-evaluator/issues/56)) ([ab37336](https://github.com/rservant/speech-evaluator/commit/ab373361029fce50f1cfe8597ea07819fde7db03))
* add MeetingRole interface and RoleRegistry ([#72](https://github.com/rservant/speech-evaluator/issues/72)) ([e4f55a1](https://github.com/rservant/speech-evaluator/commit/e4f55a115ef87e83335d2c62e63c9de112172460))
* add PWA manifest with proportional icons ([#39](https://github.com/rservant/speech-evaluator/issues/39)) ([972f237](https://github.com/rservant/speech-evaluator/commit/972f2371b12634797b9f52468fb904ccc1b842dc))
* add Red Taverns branding — favicon and footer ([#45](https://github.com/rservant/speech-evaluator/issues/45)) ([864a8fe](https://github.com/rservant/speech-evaluator/commit/864a8feb841244048d27e85c71b74d9105ba7bf1))
* add semver versioning with dynamic footer display ([#15](https://github.com/rservant/speech-evaluator/issues/15)) ([fa2d3f0](https://github.com/rservant/speech-evaluator/commit/fa2d3f067e091279a27ff1fe608f49b0d4418d82))
* add ServiceRegistry for typed dependency injection ([#86](https://github.com/rservant/speech-evaluator/issues/86)) ([e71b072](https://github.com/rservant/speech-evaluator/commit/e71b072e41275593610c0d3b36c7467dc45629e3))
* add stub face/pose detectors and wire into SessionManager ([#21](https://github.com/rservant/speech-evaluator/issues/21), [#22](https://github.com/rservant/speech-evaluator/issues/22), [#23](https://github.com/rservant/speech-evaluator/issues/23)) ([c05bd66](https://github.com/rservant/speech-evaluator/commit/c05bd66fda8e6282ebf1f98529e8932b92ea1dd9))
* add Table Topics Evaluator role — impromptu speech evaluation ([#77](https://github.com/rservant/speech-evaluator/issues/77)) ([8b01309](https://github.com/rservant/speech-evaluator/commit/8b01309af74bb279737949c8b224aefff35ff513))
* add Table Topics Master role — LLM-based prompt generation ([#76](https://github.com/rservant/speech-evaluator/issues/76)) ([4b7633d](https://github.com/rservant/speech-evaluator/commit/4b7633db28689bad0c26a000c0076e3e0127703b))
* add Timer role — deterministic timing analysis with zone classification ([#74](https://github.com/rservant/speech-evaluator/issues/74)) ([69cf3be](https://github.com/rservant/speech-evaluator/commit/69cf3bedc9726d7855e2492c7449487a35c6ba6e))
* add video/audio upload endpoint with offline pipeline ([#24](https://github.com/rservant/speech-evaluator/issues/24), [#25](https://github.com/rservant/speech-evaluator/issues/25), [#26](https://github.com/rservant/speech-evaluator/issues/26)) ([53f25a1](https://github.com/rservant/speech-evaluator/commit/53f25a1e201dfd9affff5aa8412f0b10653cd02d))
* **ai-toastmasters-evaluator:** Add initial specification and design documentation ([2c7be8c](https://github.com/rservant/speech-evaluator/commit/2c7be8cee83d5685ed44dfbcfa0dbe8148d85f2f))
* **ai-toastmasters-evaluator:** Implement core evaluation engine with TypeScript ([c85077c](https://github.com/rservant/speech-evaluator/commit/c85077c969f27886293ec101a71550a21c169da6))
* **audio-capture:** Add audio level metering and server initialization ([b1e2930](https://github.com/rservant/speech-evaluator/commit/b1e2930e37b5246a8847444bf682ba4a50802281))
* capture live speech audio via MediaRecorder for download ZIP ([#60](https://github.com/rservant/speech-evaluator/issues/60)) ([6ea0102](https://github.com/rservant/speech-evaluator/commit/6ea0102b5d09207af06f5a7d21566341f8738378))
* configurable Firebase auth domain via FIREBASE_AUTH_DOMAIN env var ([#70](https://github.com/rservant/speech-evaluator/issues/70)) ([c4ef851](https://github.com/rservant/speech-evaluator/commit/c4ef8518393ac71020706cbcb49852d00f8f6601))
* display user info in page banner ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([81340fa](https://github.com/rservant/speech-evaluator/commit/81340fa9382030b981ab24bd630159e27bc8d930))
* download evaluation outputs as ZIP on save ([#55](https://github.com/rservant/speech-evaluator/issues/55)) ([c3cafd2](https://github.com/rservant/speech-evaluator/commit/c3cafd29d47e75fdc735543417c7316f2ea0015a))
* **eager-evaluation-pipeline:** Implement core eager pipeline with deferred promises and cache validity ([3472a55](https://github.com/rservant/speech-evaluator/commit/3472a553611f7bda667879a68787c62ba79e94fe))
* Establish core engineering workflows for TDD and pre-task orientation with dedicated rule documentation. ([bf40415](https://github.com/rservant/speech-evaluator/commit/bf40415183fe5c6f3e1b6345fdfb74ae0e8276b8))
* extend req.user with name and picture from JWT ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([0c6c88f](https://github.com/rservant/speech-evaluator/commit/0c6c88f30d638cdcea53e6e4bfdf30668cb6bacb))
* externalize LLM prompts into template files ([#82](https://github.com/rservant/speech-evaluator/issues/82)) ([aa4cb96](https://github.com/rservant/speech-evaluator/commit/aa4cb96cbd913cc8dc6521cd020479f7a46621e6))
* extract shared EvaluationPipeline service ([#79](https://github.com/rservant/speech-evaluator/issues/79)) ([dd2111a](https://github.com/rservant/speech-evaluator/commit/dd2111accda6e9548abb6222428c293ec341d30f))
* include TTS audio in download ZIP ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([1ecea1b](https://github.com/rservant/speech-evaluator/commit/1ecea1bde26e705b34bc8139c47da069b7dc76d7))
* integrate roles into server and frontend ([#72](https://github.com/rservant/speech-evaluator/issues/72)) ([ab31310](https://github.com/rservant/speech-evaluator/commit/ab31310ff81409e42ee9e024b4bd69ff471ccced))
* introduce typed EventBus for pipeline decoupling ([#83](https://github.com/rservant/speech-evaluator/issues/83)) ([cfc3e3a](https://github.com/rservant/speech-evaluator/commit/cfc3e3a74864ca35a23e044790f3ced98d530184))
* persist form state across page refreshes via localStorage ([#58](https://github.com/rservant/speech-evaluator/issues/58)) ([0f0afec](https://github.com/rservant/speech-evaluator/commit/0f0afec0b69d98592904e9a88981e68c8e171ec6))
* Phase 3 — Semi-Automation (VAD, Project Context, Evidence UI) ([76bcb53](https://github.com/rservant/speech-evaluator/commit/76bcb539e33a19def4c7241a232553bf0969e006))
* **phase-2-core:** Implement consent management, tone checking, and metrics enhancement ([f4b970b](https://github.com/rservant/speech-evaluator/commit/f4b970b1c462968abaf6f9512a2b1034b1343428))
* **phase-3-semi-automation:** Implement VAD monitoring, project context, and evidence UI ([5edf64a](https://github.com/rservant/speech-evaluator/commit/5edf64a4a31370e7cc6c67fbb299a697eff7953a))
* **phase-4-video-processor:** Implement video processing pipeline with frame codec, queue, sampler, and processor ([908fd8f](https://github.com/rservant/speech-evaluator/commit/908fd8fc2f4b9b6805a87bb1868b4d75c41a553d))
* **pipeline:** Wire up complete evaluation pipeline with all dependencies ([91962d9](https://github.com/rservant/speech-evaluator/commit/91962d9fd48af5bcd91629ff80e7e485e095c76e))
* **processing-indicator:** Simplify pipeline stage updates and initialize video processor ([46543e4](https://github.com/rservant/speech-evaluator/commit/46543e4b0f0a8176c6a4c5f1f0cc90ac5ff080a3))
* **redaction:** Disable third-party name redaction, update tests and docs ([c7f26f4](https://github.com/rservant/speech-evaluator/commit/c7f26f480d601f3e14d58631e674b548d82015fe))
* register Table Topics Master, Evaluator, and General Evaluator ([#72](https://github.com/rservant/speech-evaluator/issues/72)) ([88593a3](https://github.com/rservant/speech-evaluator/commit/88593a35b30976e2fe3d3d18e5e70c745901a02f))
* register Timer and Grammarian roles in RoleRegistry ([#72](https://github.com/rservant/speech-evaluator/issues/72)) ([96a4401](https://github.com/rservant/speech-evaluator/commit/96a4401e30be8de27e2e0598429d629994975cba))
* rename application from AI Toastmasters Evaluator to AI Speech Evaluator ([5f948a0](https://github.com/rservant/speech-evaluator/commit/5f948a0525b761cea24884cce5985673fa3b1ff3))
* replace stub detectors with real ML (BlazeFace + MoveNet via TF.js WASM) ([7d2a15b](https://github.com/rservant/speech-evaluator/commit/7d2a15b359c74e41daf171cc5c2d41ecbdf34a25)), closes [#27](https://github.com/rservant/speech-evaluator/issues/27)
* responsive video preview with mirror transform and light theme ([#49](https://github.com/rservant/speech-evaluator/issues/49)) ([2f88afc](https://github.com/rservant/speech-evaluator/commit/2f88afcc97fa52a768b1b1026e25e309dcd468c7))
* split frontend into ES modules ([#80](https://github.com/rservant/speech-evaluator/issues/80)) ([d6d95b9](https://github.com/rservant/speech-evaluator/commit/d6d95b9c25bf9f63c4161ab524ea252295e44349))
* **tts-audio-delivery:** Send TTS audio as raw binary frames instead of JSON ([938b8b4](https://github.com/rservant/speech-evaluator/commit/938b8b4e7c577e6941dd3c2205dfdb8c7e9425f2))
* **tts-audio-replay-and-save:** Add TTS audio caching, replay, and persistence ([9ebb3bf](https://github.com/rservant/speech-evaluator/commit/9ebb3bf877edbcda015d392a618d8d5b754a85df))
* **tts-audio-replay-and-save:** Complete TTS audio caching, replay, and persistence ([f128fd1](https://github.com/rservant/speech-evaluator/commit/f128fd14c73170a51a902d7dd356b1c339b03d3f))
* **tts-autoplay-policy:** Enhance audio element priming with AudioContext unlock ([a482420](https://github.com/rservant/speech-evaluator/commit/a4824205e8ea394cf08269f3afdf3effd7c5d32c))
* **tts-autoplay-policy:** Implement audio element priming for browser autoplay compliance ([fdc80ae](https://github.com/rservant/speech-evaluator/commit/fdc80ae0b5478091705b9dc73d7f988c3ff6c3e7))
* **tts-playback-deferral:** Implement playback instance token and deferral state management ([dbea68f](https://github.com/rservant/speech-evaluator/commit/dbea68f16f70bf4a2570493f428bea2bb0743e39))
* **ui-logging-video-consent:** Refactor deliver button logic, enhance logging, and update video consent payload ([0bdb096](https://github.com/rservant/speech-evaluator/commit/0bdb0960398e8e94cb4bdaef5d4991fa7a773969))
* **ui-state-management:** Enable replay button when TTS audio and evaluation data are available ([27c5a18](https://github.com/rservant/speech-evaluator/commit/27c5a18a3208ad677993c964c31e66db82c029cf))
* **ui:** enlarge video preview with resize and expand toggle ([#20](https://github.com/rservant/speech-evaluator/issues/20)) ([6987d5a](https://github.com/rservant/speech-evaluator/commit/6987d5a0aea00d1edfcbbacb8dcce4a08c6feb6e))
* **ui:** extract CSS and redesign with taverns-red design system ([#12](https://github.com/rservant/speech-evaluator/issues/12)) ([5314309](https://github.com/rservant/speech-evaluator/commit/5314309499902a1edc43b09b964337501dae577d))
* upload pipeline stepper with animated steps ([#96](https://github.com/rservant/speech-evaluator/issues/96)) ([bbf2d3e](https://github.com/rservant/speech-evaluator/commit/bbf2d3e939ff7407e61db9cb90a974343475bae7))
* upload progress UX — speed, ETA, elapsed timer, cancel, retry ([#95](https://github.com/rservant/speech-evaluator/issues/95) [#97](https://github.com/rservant/speech-evaluator/issues/97) [#98](https://github.com/rservant/speech-evaluator/issues/98) [#100](https://github.com/rservant/speech-evaluator/issues/100)) ([dfe8da6](https://github.com/rservant/speech-evaluator/commit/dfe8da6b16c41b35ed0f3ee2390d79057b7988f5))
* **vad-integration:** Integrate VAD monitor into session manager initialization ([51de6ec](https://github.com/rservant/speech-evaluator/commit/51de6ec3f59201abeb8a9ceaa8cb57c2c0d9caab))
* **video-quality:** Fix grade computation for pose-only mode and add capabilities ([6cf3e9e](https://github.com/rservant/speech-evaluator/commit/6cf3e9ef8e4165223f3283c22e445bfa16c3e3b8))
* WebSocket auto-reconnect with exponential backoff ([#47](https://github.com/rservant/speech-evaluator/issues/47)) ([60324a6](https://github.com/rservant/speech-evaluator/commit/60324a62715c01fa3a1afabefd4562b6eb05e662))
* wire role pipeline execution — set_active_roles + role_results messages ([#72](https://github.com/rservant/speech-evaluator/issues/72), [#73](https://github.com/rservant/speech-evaluator/issues/73)) ([0bdcd21](https://github.com/rservant/speech-evaluator/commit/0bdcd21c960be056e515daead4e8698181a21c42))


### Bug Fixes

* add rate limiting and path traversal guard to upload handler ([81fcba9](https://github.com/rservant/speech-evaluator/commit/81fcba954040be878d50c94f360b19de9ab1e4a8))
* destructure PDFParse named export from pdf-parse ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([ed0a384](https://github.com/rservant/speech-evaluator/commit/ed0a384dcad363b2244058388ddd9225cfd3ecc3))
* download button does nothing — double-encoding bug ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([39b9c16](https://github.com/rservant/speech-evaluator/commit/39b9c16620950f5edba39a7050d0a758aff495f0))
* enforce 32MB upload limit matching Cloud Run HTTP/1.1 body size ([#65](https://github.com/rservant/speech-evaluator/issues/65)) ([ef68e20](https://github.com/rservant/speech-evaluator/commit/ef68e209262f355d242ff6bee0ee1d97282cc695))
* escape role report title and heading to prevent XSS (CodeQL [#4](https://github.com/rservant/speech-evaluator/issues/4)) ([b03a47e](https://github.com/rservant/speech-evaluator/commit/b03a47ec128ddfe806b4d868976faa5f3a8546b7))
* evaluation shows only types, no content + no TTS playback ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([d82c487](https://github.com/rservant/speech-evaluator/commit/d82c4870057da341e4520d1e289f8625594b123d))
* extract version into side-effect-free module for CI ([#18](https://github.com/rservant/speech-evaluator/issues/18)) ([809fd67](https://github.com/rservant/speech-evaluator/commit/809fd674d8a85a349f5f98e438164b72399dbb93))
* footer phase label, video_stream_ready fields, var→const ([#4](https://github.com/rservant/speech-evaluator/issues/4), [#5](https://github.com/rservant/speech-evaluator/issues/5), [#6](https://github.com/rservant/speech-evaluator/issues/6)) ([319301e](https://github.com/rservant/speech-evaluator/commit/319301e9d705cb571fec1a5756ea40b30992f537))
* full page reload after sign-out to re-initialize Firebase ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([804fdc9](https://github.com/rservant/speech-evaluator/commit/804fdc9e34a168d7a8a5882932db632ae61fe67e))
* increase Cloud Run WebSocket timeout to 3600s ([#53](https://github.com/rservant/speech-evaluator/issues/53)) ([969dfa2](https://github.com/rservant/speech-evaluator/commit/969dfa22babb7e10df47dfed7c42ccda026f8ae9))
* increase JSON body limit to 10MB for upload endpoints ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([36f270d](https://github.com/rservant/speech-evaluator/commit/36f270d1f3eb600af99e77d9b5ae11c69086972f))
* install ffmpeg in Docker runtime image ([#66](https://github.com/rservant/speech-evaluator/issues/66)) ([b060eec](https://github.com/rservant/speech-evaluator/commit/b060eec0b967bcf512784c7e8e74f687bdda5a33))
* **metrics-extractor:** Resolve type casting and initialize missing visual metrics ([0e55539](https://github.com/rservant/speech-evaluator/commit/0e55539c28a22a21c051122a3974ebcb0ee800ff))
* mode tabs, speed/ETA, and legacy upload progress tracking ([#105](https://github.com/rservant/speech-evaluator/issues/105)) ([62b1c9e](https://github.com/rservant/speech-evaluator/commit/62b1c9e1733bde9015d1062e1e64e16a3f4dc4dc))
* preserve completed_form through validation pipeline and enable legacy upload form support ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([66d0050](https://github.com/rservant/speech-evaluator/commit/66d0050dd90dbeae44f5b1f7338048dd1f38dddb))
* prevent double-click Start Speech, responsive mobile status bar, debounce consent messages ([96feafc](https://github.com/rservant/speech-evaluator/commit/96feafc62b19904645c677a99bd65aeb9137d473))
* property test uses actual bbox height for gesture threshold ([#46](https://github.com/rservant/speech-evaluator/issues/46)) ([48b086c](https://github.com/rservant/speech-evaluator/commit/48b086c7e67eb8d0bed889877f68bf4895e8ca11))
* reduce Whisper chunk size to 24MB to prevent 413 errors ([#91](https://github.com/rservant/speech-evaluator/issues/91)) ([d3868b8](https://github.com/rservant/speech-evaluator/commit/d3868b86b0890a45d318bb997c05d1a601596aae))
* remove extensionHeaders from GCS signed URL ([#66](https://github.com/rservant/speech-evaluator/issues/66)) ([e667a8f](https://github.com/rservant/speech-evaluator/commit/e667a8f449e00d1876568628ef7e7bb25fdb0bcc))
* remove Firebase API key from source control — serve from /api/config ([#50](https://github.com/rservant/speech-evaluator/issues/50)) ([9d1f565](https://github.com/rservant/speech-evaluator/commit/9d1f5654dfe6812a6786a99e21e4948c91b1e07b))
* remove release-type from action inputs — config file conflict ([8e68796](https://github.com/rservant/speech-evaluator/commit/8e687961b90fd82c6e0daf1a8a15340e4bb471ed))
* replace innerHTML with DOM APIs in evidence highlighting ([#44](https://github.com/rservant/speech-evaluator/issues/44)) ([d91b807](https://github.com/rservant/speech-evaluator/commit/d91b8075fd226a75004bfa6d8bdad6c89ba0bb29))
* revert to signInWithPopup now that API key is correct ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([3bd809f](https://github.com/rservant/speech-evaluator/commit/3bd809f2988fc4518aed467f7e23da97a4bdaf57))
* sign-out clears Firebase Auth session via signOut() ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([2b89cdb](https://github.com/rservant/speech-evaluator/commit/2b89cdb85e31a1dc9152357660d232e759bd60b1))
* switch from signInWithPopup to signInWithRedirect ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([453c26c](https://github.com/rservant/speech-evaluator/commit/453c26c683a8e5454843abe19c7a0ca0328fb8ad))
* **transcription-engine:** Correct audio buffer conversion for OpenAI API ([5a25baa](https://github.com/rservant/speech-evaluator/commit/5a25baa12f07bf07d865f5dfd558949ab3845114))
* trim API keys and add uncaught exception handler ([#48](https://github.com/rservant/speech-evaluator/issues/48)) ([28964f3](https://github.com/rservant/speech-evaluator/commit/28964f31e007252fdfd36c16d6939d2538d3169a))
* unify connection status indicators to prevent contradictory messaging ([#90](https://github.com/rservant/speech-evaluator/issues/90)) ([d6ab8cb](https://github.com/rservant/speech-evaluator/commit/d6ab8cb54676f8a41bbaa85757773aa847241456))
* update Firebase config with correct SDK credentials ([#37](https://github.com/rservant/speech-evaluator/issues/37)) ([682dff8](https://github.com/rservant/speech-evaluator/commit/682dff8f81a4635d5057898f0ae740f32a654783))
* update to pdf-parse v2 API for form extraction ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([2232e4b](https://github.com/rservant/speech-evaluator/commit/2232e4b8c2d8caa67c4aaf3c34b9062b64cceba0))
* upload evaluation not displayed — wrong element IDs ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([12263a8](https://github.com/rservant/speech-evaluator/commit/12263a823935a57051a3bc97b4007571e8bf5291))
* use Cloud Run readiness status instead of HTTP health check ([#36](https://github.com/rservant/speech-evaluator/issues/36)) ([499ecca](https://github.com/rservant/speech-evaluator/commit/499ecca6913534f4736e3bb6102573129adc20fa))
* use createRequire for CJS-only pdf-parse in ESM context ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([38fa277](https://github.com/rservant/speech-evaluator/commit/38fa2772c8b71a797e0144c09a2fa0a54be4391d))
* use impersonate-service-account for CI health check token ([#36](https://github.com/rservant/speech-evaluator/issues/36)) ([4d23d22](https://github.com/rservant/speech-evaluator/commit/4d23d22e38bd0a9d1180c8044104cd4ff63e776b))
* use whisper-1 for upload transcription with model override and chunking ([#57](https://github.com/rservant/speech-evaluator/issues/57)) ([0ece7bd](https://github.com/rservant/speech-evaluator/commit/0ece7bd311e2df45edd52724901c2dc270a5c7cc))
* video upload fails with large files and cryptic error ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([f14ad2f](https://github.com/rservant/speech-evaluator/commit/f14ad2fc86aa8d056f145a50e8c78a1b9a424c02))


### Performance Improvements

* defer WebSocket connection until live session starts ([#59](https://github.com/rservant/speech-evaluator/issues/59)) ([32acf64](https://github.com/rservant/speech-evaluator/commit/32acf648a5453f5e5dfa939d0a909ac5c241831d))

## [0.6.11](https://github.com/rservant/speech-evaluator/compare/ai-speech-evaluator-v0.6.10...ai-speech-evaluator-v0.6.11) (2026-03-15)


### Features

* configurable Firebase auth domain via FIREBASE_AUTH_DOMAIN env var ([#70](https://github.com/rservant/speech-evaluator/issues/70)) ([c4ef851](https://github.com/rservant/speech-evaluator/commit/c4ef8518393ac71020706cbcb49852d00f8f6601))
* upload pipeline stepper with animated steps ([#96](https://github.com/rservant/speech-evaluator/issues/96)) ([bbf2d3e](https://github.com/rservant/speech-evaluator/commit/bbf2d3e939ff7407e61db9cb90a974343475bae7))

## [0.6.10](https://github.com/rservant/speech-evaluator/compare/ai-speech-evaluator-v0.6.9...ai-speech-evaluator-v0.6.10) (2026-03-15)


### Features

* accept uploaded evaluation forms to guide evaluation ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([0755950](https://github.com/rservant/speech-evaluator/commit/0755950a63a8897c70ba0b7b2ecee349a8a7cca9))
* add AI Ah-Counter role — first meeting role implementation ([#73](https://github.com/rservant/speech-evaluator/issues/73)) ([58ce18e](https://github.com/rservant/speech-evaluator/commit/58ce18e9e9848404767d477b333fd9ece39316bc))
* add camera flip button for mobile front/rear camera switching ([#51](https://github.com/rservant/speech-evaluator/issues/51)) ([a46190f](https://github.com/rservant/speech-evaluator/commit/a46190ff3043338906d93aa788aa6a67051a3274))
* add CI/CD deploy job to GitHub Actions workflow ([#36](https://github.com/rservant/speech-evaluator/issues/36)) ([891c1b1](https://github.com/rservant/speech-evaluator/commit/891c1b1a7dc20d1dd648d2b72add6874155de145))
* add download evaluation button to upload flow ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([9eba51e](https://github.com/rservant/speech-evaluator/commit/9eba51ef7300abb3147116a630a392a7ec6456bb))
* add Firebase Auth with email allowlist ([#37](https://github.com/rservant/speech-evaluator/issues/37)) ([aedcc3c](https://github.com/rservant/speech-evaluator/commit/aedcc3c79c701bb1ee31e15fcd73092e6c187750))
* add GCS signed URL uploads for large video files ([#66](https://github.com/rservant/speech-evaluator/issues/66)) ([27c9186](https://github.com/rservant/speech-evaluator/commit/27c9186f4bf029f7f62a8622624a683fcd8ff8d9))
* add Grammarian role — LLM-based grammar analysis with fallback ([#75](https://github.com/rservant/speech-evaluator/issues/75)) ([5be59f3](https://github.com/rservant/speech-evaluator/commit/5be59f3cc80f2b2cfa9d674268326a7cf421fa34))
* Add iMessage notification workflow and remove outdated macOS native skill documentation. ([1fffcdd](https://github.com/rservant/speech-evaluator/commit/1fffcdd29ca891e52358cd1a5c11b7119fd56dc0))
* add light/dark theme toggle with localStorage persistence ([#56](https://github.com/rservant/speech-evaluator/issues/56)) ([ab37336](https://github.com/rservant/speech-evaluator/commit/ab373361029fce50f1cfe8597ea07819fde7db03))
* add MeetingRole interface and RoleRegistry ([#72](https://github.com/rservant/speech-evaluator/issues/72)) ([e4f55a1](https://github.com/rservant/speech-evaluator/commit/e4f55a115ef87e83335d2c62e63c9de112172460))
* add PWA manifest with proportional icons ([#39](https://github.com/rservant/speech-evaluator/issues/39)) ([972f237](https://github.com/rservant/speech-evaluator/commit/972f2371b12634797b9f52468fb904ccc1b842dc))
* add Red Taverns branding — favicon and footer ([#45](https://github.com/rservant/speech-evaluator/issues/45)) ([864a8fe](https://github.com/rservant/speech-evaluator/commit/864a8feb841244048d27e85c71b74d9105ba7bf1))
* add semver versioning with dynamic footer display ([#15](https://github.com/rservant/speech-evaluator/issues/15)) ([fa2d3f0](https://github.com/rservant/speech-evaluator/commit/fa2d3f067e091279a27ff1fe608f49b0d4418d82))
* add ServiceRegistry for typed dependency injection ([#86](https://github.com/rservant/speech-evaluator/issues/86)) ([e71b072](https://github.com/rservant/speech-evaluator/commit/e71b072e41275593610c0d3b36c7467dc45629e3))
* add stub face/pose detectors and wire into SessionManager ([#21](https://github.com/rservant/speech-evaluator/issues/21), [#22](https://github.com/rservant/speech-evaluator/issues/22), [#23](https://github.com/rservant/speech-evaluator/issues/23)) ([c05bd66](https://github.com/rservant/speech-evaluator/commit/c05bd66fda8e6282ebf1f98529e8932b92ea1dd9))
* add Timer role — deterministic timing analysis with zone classification ([#74](https://github.com/rservant/speech-evaluator/issues/74)) ([69cf3be](https://github.com/rservant/speech-evaluator/commit/69cf3bedc9726d7855e2492c7449487a35c6ba6e))
* add video/audio upload endpoint with offline pipeline ([#24](https://github.com/rservant/speech-evaluator/issues/24), [#25](https://github.com/rservant/speech-evaluator/issues/25), [#26](https://github.com/rservant/speech-evaluator/issues/26)) ([53f25a1](https://github.com/rservant/speech-evaluator/commit/53f25a1e201dfd9affff5aa8412f0b10653cd02d))
* **ai-toastmasters-evaluator:** Add initial specification and design documentation ([2c7be8c](https://github.com/rservant/speech-evaluator/commit/2c7be8cee83d5685ed44dfbcfa0dbe8148d85f2f))
* **ai-toastmasters-evaluator:** Implement core evaluation engine with TypeScript ([c85077c](https://github.com/rservant/speech-evaluator/commit/c85077c969f27886293ec101a71550a21c169da6))
* **audio-capture:** Add audio level metering and server initialization ([b1e2930](https://github.com/rservant/speech-evaluator/commit/b1e2930e37b5246a8847444bf682ba4a50802281))
* capture live speech audio via MediaRecorder for download ZIP ([#60](https://github.com/rservant/speech-evaluator/issues/60)) ([6ea0102](https://github.com/rservant/speech-evaluator/commit/6ea0102b5d09207af06f5a7d21566341f8738378))
* display user info in page banner ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([81340fa](https://github.com/rservant/speech-evaluator/commit/81340fa9382030b981ab24bd630159e27bc8d930))
* download evaluation outputs as ZIP on save ([#55](https://github.com/rservant/speech-evaluator/issues/55)) ([c3cafd2](https://github.com/rservant/speech-evaluator/commit/c3cafd29d47e75fdc735543417c7316f2ea0015a))
* **eager-evaluation-pipeline:** Implement core eager pipeline with deferred promises and cache validity ([3472a55](https://github.com/rservant/speech-evaluator/commit/3472a553611f7bda667879a68787c62ba79e94fe))
* Establish core engineering workflows for TDD and pre-task orientation with dedicated rule documentation. ([bf40415](https://github.com/rservant/speech-evaluator/commit/bf40415183fe5c6f3e1b6345fdfb74ae0e8276b8))
* extend req.user with name and picture from JWT ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([0c6c88f](https://github.com/rservant/speech-evaluator/commit/0c6c88f30d638cdcea53e6e4bfdf30668cb6bacb))
* externalize LLM prompts into template files ([#82](https://github.com/rservant/speech-evaluator/issues/82)) ([aa4cb96](https://github.com/rservant/speech-evaluator/commit/aa4cb96cbd913cc8dc6521cd020479f7a46621e6))
* extract shared EvaluationPipeline service ([#79](https://github.com/rservant/speech-evaluator/issues/79)) ([dd2111a](https://github.com/rservant/speech-evaluator/commit/dd2111accda6e9548abb6222428c293ec341d30f))
* include TTS audio in download ZIP ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([1ecea1b](https://github.com/rservant/speech-evaluator/commit/1ecea1bde26e705b34bc8139c47da069b7dc76d7))
* integrate roles into server and frontend ([#72](https://github.com/rservant/speech-evaluator/issues/72)) ([ab31310](https://github.com/rservant/speech-evaluator/commit/ab31310ff81409e42ee9e024b4bd69ff471ccced))
* introduce typed EventBus for pipeline decoupling ([#83](https://github.com/rservant/speech-evaluator/issues/83)) ([cfc3e3a](https://github.com/rservant/speech-evaluator/commit/cfc3e3a74864ca35a23e044790f3ced98d530184))
* persist form state across page refreshes via localStorage ([#58](https://github.com/rservant/speech-evaluator/issues/58)) ([0f0afec](https://github.com/rservant/speech-evaluator/commit/0f0afec0b69d98592904e9a88981e68c8e171ec6))
* Phase 3 — Semi-Automation (VAD, Project Context, Evidence UI) ([76bcb53](https://github.com/rservant/speech-evaluator/commit/76bcb539e33a19def4c7241a232553bf0969e006))
* **phase-2-core:** Implement consent management, tone checking, and metrics enhancement ([f4b970b](https://github.com/rservant/speech-evaluator/commit/f4b970b1c462968abaf6f9512a2b1034b1343428))
* **phase-3-semi-automation:** Implement VAD monitoring, project context, and evidence UI ([5edf64a](https://github.com/rservant/speech-evaluator/commit/5edf64a4a31370e7cc6c67fbb299a697eff7953a))
* **phase-4-video-processor:** Implement video processing pipeline with frame codec, queue, sampler, and processor ([908fd8f](https://github.com/rservant/speech-evaluator/commit/908fd8fc2f4b9b6805a87bb1868b4d75c41a553d))
* **pipeline:** Wire up complete evaluation pipeline with all dependencies ([91962d9](https://github.com/rservant/speech-evaluator/commit/91962d9fd48af5bcd91629ff80e7e485e095c76e))
* **processing-indicator:** Simplify pipeline stage updates and initialize video processor ([46543e4](https://github.com/rservant/speech-evaluator/commit/46543e4b0f0a8176c6a4c5f1f0cc90ac5ff080a3))
* **redaction:** Disable third-party name redaction, update tests and docs ([c7f26f4](https://github.com/rservant/speech-evaluator/commit/c7f26f480d601f3e14d58631e674b548d82015fe))
* register Timer and Grammarian roles in RoleRegistry ([#72](https://github.com/rservant/speech-evaluator/issues/72)) ([96a4401](https://github.com/rservant/speech-evaluator/commit/96a4401e30be8de27e2e0598429d629994975cba))
* rename application from AI Toastmasters Evaluator to AI Speech Evaluator ([5f948a0](https://github.com/rservant/speech-evaluator/commit/5f948a0525b761cea24884cce5985673fa3b1ff3))
* replace stub detectors with real ML (BlazeFace + MoveNet via TF.js WASM) ([7d2a15b](https://github.com/rservant/speech-evaluator/commit/7d2a15b359c74e41daf171cc5c2d41ecbdf34a25)), closes [#27](https://github.com/rservant/speech-evaluator/issues/27)
* responsive video preview with mirror transform and light theme ([#49](https://github.com/rservant/speech-evaluator/issues/49)) ([2f88afc](https://github.com/rservant/speech-evaluator/commit/2f88afcc97fa52a768b1b1026e25e309dcd468c7))
* split frontend into ES modules ([#80](https://github.com/rservant/speech-evaluator/issues/80)) ([d6d95b9](https://github.com/rservant/speech-evaluator/commit/d6d95b9c25bf9f63c4161ab524ea252295e44349))
* **tts-audio-delivery:** Send TTS audio as raw binary frames instead of JSON ([938b8b4](https://github.com/rservant/speech-evaluator/commit/938b8b4e7c577e6941dd3c2205dfdb8c7e9425f2))
* **tts-audio-replay-and-save:** Add TTS audio caching, replay, and persistence ([9ebb3bf](https://github.com/rservant/speech-evaluator/commit/9ebb3bf877edbcda015d392a618d8d5b754a85df))
* **tts-audio-replay-and-save:** Complete TTS audio caching, replay, and persistence ([f128fd1](https://github.com/rservant/speech-evaluator/commit/f128fd14c73170a51a902d7dd356b1c339b03d3f))
* **tts-autoplay-policy:** Enhance audio element priming with AudioContext unlock ([a482420](https://github.com/rservant/speech-evaluator/commit/a4824205e8ea394cf08269f3afdf3effd7c5d32c))
* **tts-autoplay-policy:** Implement audio element priming for browser autoplay compliance ([fdc80ae](https://github.com/rservant/speech-evaluator/commit/fdc80ae0b5478091705b9dc73d7f988c3ff6c3e7))
* **tts-playback-deferral:** Implement playback instance token and deferral state management ([dbea68f](https://github.com/rservant/speech-evaluator/commit/dbea68f16f70bf4a2570493f428bea2bb0743e39))
* **ui-logging-video-consent:** Refactor deliver button logic, enhance logging, and update video consent payload ([0bdb096](https://github.com/rservant/speech-evaluator/commit/0bdb0960398e8e94cb4bdaef5d4991fa7a773969))
* **ui-state-management:** Enable replay button when TTS audio and evaluation data are available ([27c5a18](https://github.com/rservant/speech-evaluator/commit/27c5a18a3208ad677993c964c31e66db82c029cf))
* **ui:** enlarge video preview with resize and expand toggle ([#20](https://github.com/rservant/speech-evaluator/issues/20)) ([6987d5a](https://github.com/rservant/speech-evaluator/commit/6987d5a0aea00d1edfcbbacb8dcce4a08c6feb6e))
* **ui:** extract CSS and redesign with taverns-red design system ([#12](https://github.com/rservant/speech-evaluator/issues/12)) ([5314309](https://github.com/rservant/speech-evaluator/commit/5314309499902a1edc43b09b964337501dae577d))
* upload progress UX — speed, ETA, elapsed timer, cancel, retry ([#95](https://github.com/rservant/speech-evaluator/issues/95) [#97](https://github.com/rservant/speech-evaluator/issues/97) [#98](https://github.com/rservant/speech-evaluator/issues/98) [#100](https://github.com/rservant/speech-evaluator/issues/100)) ([dfe8da6](https://github.com/rservant/speech-evaluator/commit/dfe8da6b16c41b35ed0f3ee2390d79057b7988f5))
* **vad-integration:** Integrate VAD monitor into session manager initialization ([51de6ec](https://github.com/rservant/speech-evaluator/commit/51de6ec3f59201abeb8a9ceaa8cb57c2c0d9caab))
* **video-quality:** Fix grade computation for pose-only mode and add capabilities ([6cf3e9e](https://github.com/rservant/speech-evaluator/commit/6cf3e9ef8e4165223f3283c22e445bfa16c3e3b8))
* WebSocket auto-reconnect with exponential backoff ([#47](https://github.com/rservant/speech-evaluator/issues/47)) ([60324a6](https://github.com/rservant/speech-evaluator/commit/60324a62715c01fa3a1afabefd4562b6eb05e662))
* wire role pipeline execution — set_active_roles + role_results messages ([#72](https://github.com/rservant/speech-evaluator/issues/72), [#73](https://github.com/rservant/speech-evaluator/issues/73)) ([0bdcd21](https://github.com/rservant/speech-evaluator/commit/0bdcd21c960be056e515daead4e8698181a21c42))


### Bug Fixes

* add rate limiting and path traversal guard to upload handler ([81fcba9](https://github.com/rservant/speech-evaluator/commit/81fcba954040be878d50c94f360b19de9ab1e4a8))
* destructure PDFParse named export from pdf-parse ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([ed0a384](https://github.com/rservant/speech-evaluator/commit/ed0a384dcad363b2244058388ddd9225cfd3ecc3))
* download button does nothing — double-encoding bug ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([39b9c16](https://github.com/rservant/speech-evaluator/commit/39b9c16620950f5edba39a7050d0a758aff495f0))
* enforce 32MB upload limit matching Cloud Run HTTP/1.1 body size ([#65](https://github.com/rservant/speech-evaluator/issues/65)) ([ef68e20](https://github.com/rservant/speech-evaluator/commit/ef68e209262f355d242ff6bee0ee1d97282cc695))
* escape role report title and heading to prevent XSS (CodeQL [#4](https://github.com/rservant/speech-evaluator/issues/4)) ([b03a47e](https://github.com/rservant/speech-evaluator/commit/b03a47ec128ddfe806b4d868976faa5f3a8546b7))
* evaluation shows only types, no content + no TTS playback ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([d82c487](https://github.com/rservant/speech-evaluator/commit/d82c4870057da341e4520d1e289f8625594b123d))
* extract version into side-effect-free module for CI ([#18](https://github.com/rservant/speech-evaluator/issues/18)) ([809fd67](https://github.com/rservant/speech-evaluator/commit/809fd674d8a85a349f5f98e438164b72399dbb93))
* footer phase label, video_stream_ready fields, var→const ([#4](https://github.com/rservant/speech-evaluator/issues/4), [#5](https://github.com/rservant/speech-evaluator/issues/5), [#6](https://github.com/rservant/speech-evaluator/issues/6)) ([319301e](https://github.com/rservant/speech-evaluator/commit/319301e9d705cb571fec1a5756ea40b30992f537))
* full page reload after sign-out to re-initialize Firebase ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([804fdc9](https://github.com/rservant/speech-evaluator/commit/804fdc9e34a168d7a8a5882932db632ae61fe67e))
* increase Cloud Run WebSocket timeout to 3600s ([#53](https://github.com/rservant/speech-evaluator/issues/53)) ([969dfa2](https://github.com/rservant/speech-evaluator/commit/969dfa22babb7e10df47dfed7c42ccda026f8ae9))
* increase JSON body limit to 10MB for upload endpoints ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([36f270d](https://github.com/rservant/speech-evaluator/commit/36f270d1f3eb600af99e77d9b5ae11c69086972f))
* install ffmpeg in Docker runtime image ([#66](https://github.com/rservant/speech-evaluator/issues/66)) ([b060eec](https://github.com/rservant/speech-evaluator/commit/b060eec0b967bcf512784c7e8e74f687bdda5a33))
* **metrics-extractor:** Resolve type casting and initialize missing visual metrics ([0e55539](https://github.com/rservant/speech-evaluator/commit/0e55539c28a22a21c051122a3974ebcb0ee800ff))
* preserve completed_form through validation pipeline and enable legacy upload form support ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([66d0050](https://github.com/rservant/speech-evaluator/commit/66d0050dd90dbeae44f5b1f7338048dd1f38dddb))
* prevent double-click Start Speech, responsive mobile status bar, debounce consent messages ([96feafc](https://github.com/rservant/speech-evaluator/commit/96feafc62b19904645c677a99bd65aeb9137d473))
* property test uses actual bbox height for gesture threshold ([#46](https://github.com/rservant/speech-evaluator/issues/46)) ([48b086c](https://github.com/rservant/speech-evaluator/commit/48b086c7e67eb8d0bed889877f68bf4895e8ca11))
* reduce Whisper chunk size to 24MB to prevent 413 errors ([#91](https://github.com/rservant/speech-evaluator/issues/91)) ([d3868b8](https://github.com/rservant/speech-evaluator/commit/d3868b86b0890a45d318bb997c05d1a601596aae))
* remove extensionHeaders from GCS signed URL ([#66](https://github.com/rservant/speech-evaluator/issues/66)) ([e667a8f](https://github.com/rservant/speech-evaluator/commit/e667a8f449e00d1876568628ef7e7bb25fdb0bcc))
* remove Firebase API key from source control — serve from /api/config ([#50](https://github.com/rservant/speech-evaluator/issues/50)) ([9d1f565](https://github.com/rservant/speech-evaluator/commit/9d1f5654dfe6812a6786a99e21e4948c91b1e07b))
* remove release-type from action inputs — config file conflict ([8e68796](https://github.com/rservant/speech-evaluator/commit/8e687961b90fd82c6e0daf1a8a15340e4bb471ed))
* replace innerHTML with DOM APIs in evidence highlighting ([#44](https://github.com/rservant/speech-evaluator/issues/44)) ([d91b807](https://github.com/rservant/speech-evaluator/commit/d91b8075fd226a75004bfa6d8bdad6c89ba0bb29))
* revert to signInWithPopup now that API key is correct ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([3bd809f](https://github.com/rservant/speech-evaluator/commit/3bd809f2988fc4518aed467f7e23da97a4bdaf57))
* sign-out clears Firebase Auth session via signOut() ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([2b89cdb](https://github.com/rservant/speech-evaluator/commit/2b89cdb85e31a1dc9152357660d232e759bd60b1))
* switch from signInWithPopup to signInWithRedirect ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([453c26c](https://github.com/rservant/speech-evaluator/commit/453c26c683a8e5454843abe19c7a0ca0328fb8ad))
* **transcription-engine:** Correct audio buffer conversion for OpenAI API ([5a25baa](https://github.com/rservant/speech-evaluator/commit/5a25baa12f07bf07d865f5dfd558949ab3845114))
* trim API keys and add uncaught exception handler ([#48](https://github.com/rservant/speech-evaluator/issues/48)) ([28964f3](https://github.com/rservant/speech-evaluator/commit/28964f31e007252fdfd36c16d6939d2538d3169a))
* unify connection status indicators to prevent contradictory messaging ([#90](https://github.com/rservant/speech-evaluator/issues/90)) ([d6ab8cb](https://github.com/rservant/speech-evaluator/commit/d6ab8cb54676f8a41bbaa85757773aa847241456))
* update Firebase config with correct SDK credentials ([#37](https://github.com/rservant/speech-evaluator/issues/37)) ([682dff8](https://github.com/rservant/speech-evaluator/commit/682dff8f81a4635d5057898f0ae740f32a654783))
* update to pdf-parse v2 API for form extraction ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([2232e4b](https://github.com/rservant/speech-evaluator/commit/2232e4b8c2d8caa67c4aaf3c34b9062b64cceba0))
* upload evaluation not displayed — wrong element IDs ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([12263a8](https://github.com/rservant/speech-evaluator/commit/12263a823935a57051a3bc97b4007571e8bf5291))
* use Cloud Run readiness status instead of HTTP health check ([#36](https://github.com/rservant/speech-evaluator/issues/36)) ([499ecca](https://github.com/rservant/speech-evaluator/commit/499ecca6913534f4736e3bb6102573129adc20fa))
* use createRequire for CJS-only pdf-parse in ESM context ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([38fa277](https://github.com/rservant/speech-evaluator/commit/38fa2772c8b71a797e0144c09a2fa0a54be4391d))
* use impersonate-service-account for CI health check token ([#36](https://github.com/rservant/speech-evaluator/issues/36)) ([4d23d22](https://github.com/rservant/speech-evaluator/commit/4d23d22e38bd0a9d1180c8044104cd4ff63e776b))
* use whisper-1 for upload transcription with model override and chunking ([#57](https://github.com/rservant/speech-evaluator/issues/57)) ([0ece7bd](https://github.com/rservant/speech-evaluator/commit/0ece7bd311e2df45edd52724901c2dc270a5c7cc))
* video upload fails with large files and cryptic error ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([f14ad2f](https://github.com/rservant/speech-evaluator/commit/f14ad2fc86aa8d056f145a50e8c78a1b9a424c02))


### Performance Improvements

* defer WebSocket connection until live session starts ([#59](https://github.com/rservant/speech-evaluator/issues/59)) ([32acf64](https://github.com/rservant/speech-evaluator/commit/32acf648a5453f5e5dfa939d0a909ac5c241831d))

## [0.6.9](https://github.com/rservant/speech-evaluator/compare/ai-speech-evaluator-v0.6.8...ai-speech-evaluator-v0.6.9) (2026-03-15)


### Features

* upload progress UX — speed, ETA, elapsed timer, cancel, retry ([#95](https://github.com/rservant/speech-evaluator/issues/95) [#97](https://github.com/rservant/speech-evaluator/issues/97) [#98](https://github.com/rservant/speech-evaluator/issues/98) [#100](https://github.com/rservant/speech-evaluator/issues/100)) ([dfe8da6](https://github.com/rservant/speech-evaluator/commit/dfe8da6b16c41b35ed0f3ee2390d79057b7988f5))

## [0.6.8](https://github.com/rservant/speech-evaluator/compare/ai-speech-evaluator-v0.6.7...ai-speech-evaluator-v0.6.8) (2026-03-15)


### Features

* add Grammarian role — LLM-based grammar analysis with fallback ([#75](https://github.com/rservant/speech-evaluator/issues/75)) ([5be59f3](https://github.com/rservant/speech-evaluator/commit/5be59f3cc80f2b2cfa9d674268326a7cf421fa34))
* add Timer role — deterministic timing analysis with zone classification ([#74](https://github.com/rservant/speech-evaluator/issues/74)) ([69cf3be](https://github.com/rservant/speech-evaluator/commit/69cf3bedc9726d7855e2492c7449487a35c6ba6e))
* register Timer and Grammarian roles in RoleRegistry ([#72](https://github.com/rservant/speech-evaluator/issues/72)) ([96a4401](https://github.com/rservant/speech-evaluator/commit/96a4401e30be8de27e2e0598429d629994975cba))


### Bug Fixes

* escape role report title and heading to prevent XSS (CodeQL [#4](https://github.com/rservant/speech-evaluator/issues/4)) ([b03a47e](https://github.com/rservant/speech-evaluator/commit/b03a47ec128ddfe806b4d868976faa5f3a8546b7))

## [0.6.7](https://github.com/rservant/speech-evaluator/compare/ai-speech-evaluator-v0.6.6...ai-speech-evaluator-v0.6.7) (2026-03-15)


### Features

* wire role pipeline execution — set_active_roles + role_results messages ([#72](https://github.com/rservant/speech-evaluator/issues/72), [#73](https://github.com/rservant/speech-evaluator/issues/73)) ([0bdcd21](https://github.com/rservant/speech-evaluator/commit/0bdcd21c960be056e515daead4e8698181a21c42))


### Bug Fixes

* reduce Whisper chunk size to 24MB to prevent 413 errors ([#91](https://github.com/rservant/speech-evaluator/issues/91)) ([d3868b8](https://github.com/rservant/speech-evaluator/commit/d3868b86b0890a45d318bb997c05d1a601596aae))
* unify connection status indicators to prevent contradictory messaging ([#90](https://github.com/rservant/speech-evaluator/issues/90)) ([d6ab8cb](https://github.com/rservant/speech-evaluator/commit/d6ab8cb54676f8a41bbaa85757773aa847241456))

## [0.6.6](https://github.com/rservant/speech-evaluator/compare/ai-speech-evaluator-v0.6.5...ai-speech-evaluator-v0.6.6) (2026-03-15)


### Features

* add AI Ah-Counter role — first meeting role implementation ([#73](https://github.com/rservant/speech-evaluator/issues/73)) ([58ce18e](https://github.com/rservant/speech-evaluator/commit/58ce18e9e9848404767d477b333fd9ece39316bc))
* add MeetingRole interface and RoleRegistry ([#72](https://github.com/rservant/speech-evaluator/issues/72)) ([e4f55a1](https://github.com/rservant/speech-evaluator/commit/e4f55a115ef87e83335d2c62e63c9de112172460))
* integrate roles into server and frontend ([#72](https://github.com/rservant/speech-evaluator/issues/72)) ([ab31310](https://github.com/rservant/speech-evaluator/commit/ab31310ff81409e42ee9e024b4bd69ff471ccced))

## [0.6.5](https://github.com/rservant/speech-evaluator/compare/ai-speech-evaluator-v0.6.4...ai-speech-evaluator-v0.6.5) (2026-03-15)


### Features

* add ServiceRegistry for typed dependency injection ([#86](https://github.com/rservant/speech-evaluator/issues/86)) ([e71b072](https://github.com/rservant/speech-evaluator/commit/e71b072e41275593610c0d3b36c7467dc45629e3))

## [0.6.4](https://github.com/rservant/speech-evaluator/compare/ai-speech-evaluator-v0.6.3...ai-speech-evaluator-v0.6.4) (2026-03-15)


### Features

* externalize LLM prompts into template files ([#82](https://github.com/rservant/speech-evaluator/issues/82)) ([aa4cb96](https://github.com/rservant/speech-evaluator/commit/aa4cb96cbd913cc8dc6521cd020479f7a46621e6))
* introduce typed EventBus for pipeline decoupling ([#83](https://github.com/rservant/speech-evaluator/issues/83)) ([cfc3e3a](https://github.com/rservant/speech-evaluator/commit/cfc3e3a74864ca35a23e044790f3ced98d530184))

## [0.6.3](https://github.com/rservant/speech-evaluator/compare/ai-speech-evaluator-v0.6.2...ai-speech-evaluator-v0.6.3) (2026-03-15)


### Features

* extract shared EvaluationPipeline service ([#79](https://github.com/rservant/speech-evaluator/issues/79)) ([dd2111a](https://github.com/rservant/speech-evaluator/commit/dd2111accda6e9548abb6222428c293ec341d30f))
* split frontend into ES modules ([#80](https://github.com/rservant/speech-evaluator/issues/80)) ([d6d95b9](https://github.com/rservant/speech-evaluator/commit/d6d95b9c25bf9f63c4161ab524ea252295e44349))

## [0.6.2](https://github.com/rservant/speech-evaluator/compare/ai-speech-evaluator-v0.6.1...ai-speech-evaluator-v0.6.2) (2026-03-15)


### Features

* accept uploaded evaluation forms to guide evaluation ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([0755950](https://github.com/rservant/speech-evaluator/commit/0755950a63a8897c70ba0b7b2ecee349a8a7cca9))
* add GCS signed URL uploads for large video files ([#66](https://github.com/rservant/speech-evaluator/issues/66)) ([27c9186](https://github.com/rservant/speech-evaluator/commit/27c9186f4bf029f7f62a8622624a683fcd8ff8d9))
* capture live speech audio via MediaRecorder for download ZIP ([#60](https://github.com/rservant/speech-evaluator/issues/60)) ([6ea0102](https://github.com/rservant/speech-evaluator/commit/6ea0102b5d09207af06f5a7d21566341f8738378))
* responsive video preview with mirror transform and light theme ([#49](https://github.com/rservant/speech-evaluator/issues/49)) ([2f88afc](https://github.com/rservant/speech-evaluator/commit/2f88afcc97fa52a768b1b1026e25e309dcd468c7))


### Bug Fixes

* destructure PDFParse named export from pdf-parse ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([ed0a384](https://github.com/rservant/speech-evaluator/commit/ed0a384dcad363b2244058388ddd9225cfd3ecc3))
* enforce 32MB upload limit matching Cloud Run HTTP/1.1 body size ([#65](https://github.com/rservant/speech-evaluator/issues/65)) ([ef68e20](https://github.com/rservant/speech-evaluator/commit/ef68e209262f355d242ff6bee0ee1d97282cc695))
* increase JSON body limit to 10MB for upload endpoints ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([36f270d](https://github.com/rservant/speech-evaluator/commit/36f270d1f3eb600af99e77d9b5ae11c69086972f))
* install ffmpeg in Docker runtime image ([#66](https://github.com/rservant/speech-evaluator/issues/66)) ([b060eec](https://github.com/rservant/speech-evaluator/commit/b060eec0b967bcf512784c7e8e74f687bdda5a33))
* preserve completed_form through validation pipeline and enable legacy upload form support ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([66d0050](https://github.com/rservant/speech-evaluator/commit/66d0050dd90dbeae44f5b1f7338048dd1f38dddb))
* remove extensionHeaders from GCS signed URL ([#66](https://github.com/rservant/speech-evaluator/issues/66)) ([e667a8f](https://github.com/rservant/speech-evaluator/commit/e667a8f449e00d1876568628ef7e7bb25fdb0bcc))
* update to pdf-parse v2 API for form extraction ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([2232e4b](https://github.com/rservant/speech-evaluator/commit/2232e4b8c2d8caa67c4aaf3c34b9062b64cceba0))
* use createRequire for CJS-only pdf-parse in ESM context ([#64](https://github.com/rservant/speech-evaluator/issues/64)) ([38fa277](https://github.com/rservant/speech-evaluator/commit/38fa2772c8b71a797e0144c09a2fa0a54be4391d))

## [0.6.1](https://github.com/rservant/speech-evaluator/compare/ai-speech-evaluator-v0.6.0...ai-speech-evaluator-v0.6.1) (2026-03-14)


### Features

* add camera flip button for mobile front/rear camera switching ([#51](https://github.com/rservant/speech-evaluator/issues/51)) ([a46190f](https://github.com/rservant/speech-evaluator/commit/a46190ff3043338906d93aa788aa6a67051a3274))
* add CI/CD deploy job to GitHub Actions workflow ([#36](https://github.com/rservant/speech-evaluator/issues/36)) ([891c1b1](https://github.com/rservant/speech-evaluator/commit/891c1b1a7dc20d1dd648d2b72add6874155de145))
* add download evaluation button to upload flow ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([9eba51e](https://github.com/rservant/speech-evaluator/commit/9eba51ef7300abb3147116a630a392a7ec6456bb))
* add Firebase Auth with email allowlist ([#37](https://github.com/rservant/speech-evaluator/issues/37)) ([aedcc3c](https://github.com/rservant/speech-evaluator/commit/aedcc3c79c701bb1ee31e15fcd73092e6c187750))
* Add iMessage notification workflow and remove outdated macOS native skill documentation. ([1fffcdd](https://github.com/rservant/speech-evaluator/commit/1fffcdd29ca891e52358cd1a5c11b7119fd56dc0))
* add light/dark theme toggle with localStorage persistence ([#56](https://github.com/rservant/speech-evaluator/issues/56)) ([ab37336](https://github.com/rservant/speech-evaluator/commit/ab373361029fce50f1cfe8597ea07819fde7db03))
* add PWA manifest with proportional icons ([#39](https://github.com/rservant/speech-evaluator/issues/39)) ([972f237](https://github.com/rservant/speech-evaluator/commit/972f2371b12634797b9f52468fb904ccc1b842dc))
* add Red Taverns branding — favicon and footer ([#45](https://github.com/rservant/speech-evaluator/issues/45)) ([864a8fe](https://github.com/rservant/speech-evaluator/commit/864a8feb841244048d27e85c71b74d9105ba7bf1))
* add semver versioning with dynamic footer display ([#15](https://github.com/rservant/speech-evaluator/issues/15)) ([fa2d3f0](https://github.com/rservant/speech-evaluator/commit/fa2d3f067e091279a27ff1fe608f49b0d4418d82))
* add stub face/pose detectors and wire into SessionManager ([#21](https://github.com/rservant/speech-evaluator/issues/21), [#22](https://github.com/rservant/speech-evaluator/issues/22), [#23](https://github.com/rservant/speech-evaluator/issues/23)) ([c05bd66](https://github.com/rservant/speech-evaluator/commit/c05bd66fda8e6282ebf1f98529e8932b92ea1dd9))
* add video/audio upload endpoint with offline pipeline ([#24](https://github.com/rservant/speech-evaluator/issues/24), [#25](https://github.com/rservant/speech-evaluator/issues/25), [#26](https://github.com/rservant/speech-evaluator/issues/26)) ([53f25a1](https://github.com/rservant/speech-evaluator/commit/53f25a1e201dfd9affff5aa8412f0b10653cd02d))
* **ai-toastmasters-evaluator:** Add initial specification and design documentation ([2c7be8c](https://github.com/rservant/speech-evaluator/commit/2c7be8cee83d5685ed44dfbcfa0dbe8148d85f2f))
* **ai-toastmasters-evaluator:** Implement core evaluation engine with TypeScript ([c85077c](https://github.com/rservant/speech-evaluator/commit/c85077c969f27886293ec101a71550a21c169da6))
* **audio-capture:** Add audio level metering and server initialization ([b1e2930](https://github.com/rservant/speech-evaluator/commit/b1e2930e37b5246a8847444bf682ba4a50802281))
* display user info in page banner ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([81340fa](https://github.com/rservant/speech-evaluator/commit/81340fa9382030b981ab24bd630159e27bc8d930))
* download evaluation outputs as ZIP on save ([#55](https://github.com/rservant/speech-evaluator/issues/55)) ([c3cafd2](https://github.com/rservant/speech-evaluator/commit/c3cafd29d47e75fdc735543417c7316f2ea0015a))
* **eager-evaluation-pipeline:** Implement core eager pipeline with deferred promises and cache validity ([3472a55](https://github.com/rservant/speech-evaluator/commit/3472a553611f7bda667879a68787c62ba79e94fe))
* Establish core engineering workflows for TDD and pre-task orientation with dedicated rule documentation. ([bf40415](https://github.com/rservant/speech-evaluator/commit/bf40415183fe5c6f3e1b6345fdfb74ae0e8276b8))
* extend req.user with name and picture from JWT ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([0c6c88f](https://github.com/rservant/speech-evaluator/commit/0c6c88f30d638cdcea53e6e4bfdf30668cb6bacb))
* include TTS audio in download ZIP ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([1ecea1b](https://github.com/rservant/speech-evaluator/commit/1ecea1bde26e705b34bc8139c47da069b7dc76d7))
* persist form state across page refreshes via localStorage ([#58](https://github.com/rservant/speech-evaluator/issues/58)) ([0f0afec](https://github.com/rservant/speech-evaluator/commit/0f0afec0b69d98592904e9a88981e68c8e171ec6))
* Phase 3 — Semi-Automation (VAD, Project Context, Evidence UI) ([76bcb53](https://github.com/rservant/speech-evaluator/commit/76bcb539e33a19def4c7241a232553bf0969e006))
* **phase-2-core:** Implement consent management, tone checking, and metrics enhancement ([f4b970b](https://github.com/rservant/speech-evaluator/commit/f4b970b1c462968abaf6f9512a2b1034b1343428))
* **phase-3-semi-automation:** Implement VAD monitoring, project context, and evidence UI ([5edf64a](https://github.com/rservant/speech-evaluator/commit/5edf64a4a31370e7cc6c67fbb299a697eff7953a))
* **phase-4-video-processor:** Implement video processing pipeline with frame codec, queue, sampler, and processor ([908fd8f](https://github.com/rservant/speech-evaluator/commit/908fd8fc2f4b9b6805a87bb1868b4d75c41a553d))
* **pipeline:** Wire up complete evaluation pipeline with all dependencies ([91962d9](https://github.com/rservant/speech-evaluator/commit/91962d9fd48af5bcd91629ff80e7e485e095c76e))
* **processing-indicator:** Simplify pipeline stage updates and initialize video processor ([46543e4](https://github.com/rservant/speech-evaluator/commit/46543e4b0f0a8176c6a4c5f1f0cc90ac5ff080a3))
* **redaction:** Disable third-party name redaction, update tests and docs ([c7f26f4](https://github.com/rservant/speech-evaluator/commit/c7f26f480d601f3e14d58631e674b548d82015fe))
* rename application from AI Toastmasters Evaluator to AI Speech Evaluator ([5f948a0](https://github.com/rservant/speech-evaluator/commit/5f948a0525b761cea24884cce5985673fa3b1ff3))
* replace stub detectors with real ML (BlazeFace + MoveNet via TF.js WASM) ([7d2a15b](https://github.com/rservant/speech-evaluator/commit/7d2a15b359c74e41daf171cc5c2d41ecbdf34a25)), closes [#27](https://github.com/rservant/speech-evaluator/issues/27)
* **tts-audio-delivery:** Send TTS audio as raw binary frames instead of JSON ([938b8b4](https://github.com/rservant/speech-evaluator/commit/938b8b4e7c577e6941dd3c2205dfdb8c7e9425f2))
* **tts-audio-replay-and-save:** Add TTS audio caching, replay, and persistence ([9ebb3bf](https://github.com/rservant/speech-evaluator/commit/9ebb3bf877edbcda015d392a618d8d5b754a85df))
* **tts-audio-replay-and-save:** Complete TTS audio caching, replay, and persistence ([f128fd1](https://github.com/rservant/speech-evaluator/commit/f128fd14c73170a51a902d7dd356b1c339b03d3f))
* **tts-autoplay-policy:** Enhance audio element priming with AudioContext unlock ([a482420](https://github.com/rservant/speech-evaluator/commit/a4824205e8ea394cf08269f3afdf3effd7c5d32c))
* **tts-autoplay-policy:** Implement audio element priming for browser autoplay compliance ([fdc80ae](https://github.com/rservant/speech-evaluator/commit/fdc80ae0b5478091705b9dc73d7f988c3ff6c3e7))
* **tts-playback-deferral:** Implement playback instance token and deferral state management ([dbea68f](https://github.com/rservant/speech-evaluator/commit/dbea68f16f70bf4a2570493f428bea2bb0743e39))
* **ui-logging-video-consent:** Refactor deliver button logic, enhance logging, and update video consent payload ([0bdb096](https://github.com/rservant/speech-evaluator/commit/0bdb0960398e8e94cb4bdaef5d4991fa7a773969))
* **ui-state-management:** Enable replay button when TTS audio and evaluation data are available ([27c5a18](https://github.com/rservant/speech-evaluator/commit/27c5a18a3208ad677993c964c31e66db82c029cf))
* **ui:** enlarge video preview with resize and expand toggle ([#20](https://github.com/rservant/speech-evaluator/issues/20)) ([6987d5a](https://github.com/rservant/speech-evaluator/commit/6987d5a0aea00d1edfcbbacb8dcce4a08c6feb6e))
* **ui:** extract CSS and redesign with taverns-red design system ([#12](https://github.com/rservant/speech-evaluator/issues/12)) ([5314309](https://github.com/rservant/speech-evaluator/commit/5314309499902a1edc43b09b964337501dae577d))
* **vad-integration:** Integrate VAD monitor into session manager initialization ([51de6ec](https://github.com/rservant/speech-evaluator/commit/51de6ec3f59201abeb8a9ceaa8cb57c2c0d9caab))
* **video-quality:** Fix grade computation for pose-only mode and add capabilities ([6cf3e9e](https://github.com/rservant/speech-evaluator/commit/6cf3e9ef8e4165223f3283c22e445bfa16c3e3b8))
* WebSocket auto-reconnect with exponential backoff ([#47](https://github.com/rservant/speech-evaluator/issues/47)) ([60324a6](https://github.com/rservant/speech-evaluator/commit/60324a62715c01fa3a1afabefd4562b6eb05e662))


### Bug Fixes

* add rate limiting and path traversal guard to upload handler ([81fcba9](https://github.com/rservant/speech-evaluator/commit/81fcba954040be878d50c94f360b19de9ab1e4a8))
* download button does nothing — double-encoding bug ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([39b9c16](https://github.com/rservant/speech-evaluator/commit/39b9c16620950f5edba39a7050d0a758aff495f0))
* evaluation shows only types, no content + no TTS playback ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([d82c487](https://github.com/rservant/speech-evaluator/commit/d82c4870057da341e4520d1e289f8625594b123d))
* extract version into side-effect-free module for CI ([#18](https://github.com/rservant/speech-evaluator/issues/18)) ([809fd67](https://github.com/rservant/speech-evaluator/commit/809fd674d8a85a349f5f98e438164b72399dbb93))
* footer phase label, video_stream_ready fields, var→const ([#4](https://github.com/rservant/speech-evaluator/issues/4), [#5](https://github.com/rservant/speech-evaluator/issues/5), [#6](https://github.com/rservant/speech-evaluator/issues/6)) ([319301e](https://github.com/rservant/speech-evaluator/commit/319301e9d705cb571fec1a5756ea40b30992f537))
* full page reload after sign-out to re-initialize Firebase ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([804fdc9](https://github.com/rservant/speech-evaluator/commit/804fdc9e34a168d7a8a5882932db632ae61fe67e))
* increase Cloud Run WebSocket timeout to 3600s ([#53](https://github.com/rservant/speech-evaluator/issues/53)) ([969dfa2](https://github.com/rservant/speech-evaluator/commit/969dfa22babb7e10df47dfed7c42ccda026f8ae9))
* **metrics-extractor:** Resolve type casting and initialize missing visual metrics ([0e55539](https://github.com/rservant/speech-evaluator/commit/0e55539c28a22a21c051122a3974ebcb0ee800ff))
* prevent double-click Start Speech, responsive mobile status bar, debounce consent messages ([96feafc](https://github.com/rservant/speech-evaluator/commit/96feafc62b19904645c677a99bd65aeb9137d473))
* property test uses actual bbox height for gesture threshold ([#46](https://github.com/rservant/speech-evaluator/issues/46)) ([48b086c](https://github.com/rservant/speech-evaluator/commit/48b086c7e67eb8d0bed889877f68bf4895e8ca11))
* remove Firebase API key from source control — serve from /api/config ([#50](https://github.com/rservant/speech-evaluator/issues/50)) ([9d1f565](https://github.com/rservant/speech-evaluator/commit/9d1f5654dfe6812a6786a99e21e4948c91b1e07b))
* remove release-type from action inputs — config file conflict ([8e68796](https://github.com/rservant/speech-evaluator/commit/8e687961b90fd82c6e0daf1a8a15340e4bb471ed))
* replace innerHTML with DOM APIs in evidence highlighting ([#44](https://github.com/rservant/speech-evaluator/issues/44)) ([d91b807](https://github.com/rservant/speech-evaluator/commit/d91b8075fd226a75004bfa6d8bdad6c89ba0bb29))
* revert to signInWithPopup now that API key is correct ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([3bd809f](https://github.com/rservant/speech-evaluator/commit/3bd809f2988fc4518aed467f7e23da97a4bdaf57))
* sign-out clears Firebase Auth session via signOut() ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([2b89cdb](https://github.com/rservant/speech-evaluator/commit/2b89cdb85e31a1dc9152357660d232e759bd60b1))
* switch from signInWithPopup to signInWithRedirect ([#41](https://github.com/rservant/speech-evaluator/issues/41)) ([453c26c](https://github.com/rservant/speech-evaluator/commit/453c26c683a8e5454843abe19c7a0ca0328fb8ad))
* **transcription-engine:** Correct audio buffer conversion for OpenAI API ([5a25baa](https://github.com/rservant/speech-evaluator/commit/5a25baa12f07bf07d865f5dfd558949ab3845114))
* trim API keys and add uncaught exception handler ([#48](https://github.com/rservant/speech-evaluator/issues/48)) ([28964f3](https://github.com/rservant/speech-evaluator/commit/28964f31e007252fdfd36c16d6939d2538d3169a))
* update Firebase config with correct SDK credentials ([#37](https://github.com/rservant/speech-evaluator/issues/37)) ([682dff8](https://github.com/rservant/speech-evaluator/commit/682dff8f81a4635d5057898f0ae740f32a654783))
* upload evaluation not displayed — wrong element IDs ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([12263a8](https://github.com/rservant/speech-evaluator/commit/12263a823935a57051a3bc97b4007571e8bf5291))
* use Cloud Run readiness status instead of HTTP health check ([#36](https://github.com/rservant/speech-evaluator/issues/36)) ([499ecca](https://github.com/rservant/speech-evaluator/commit/499ecca6913534f4736e3bb6102573129adc20fa))
* use impersonate-service-account for CI health check token ([#36](https://github.com/rservant/speech-evaluator/issues/36)) ([4d23d22](https://github.com/rservant/speech-evaluator/commit/4d23d22e38bd0a9d1180c8044104cd4ff63e776b))
* use whisper-1 for upload transcription with model override and chunking ([#57](https://github.com/rservant/speech-evaluator/issues/57)) ([0ece7bd](https://github.com/rservant/speech-evaluator/commit/0ece7bd311e2df45edd52724901c2dc270a5c7cc))
* video upload fails with large files and cryptic error ([#54](https://github.com/rservant/speech-evaluator/issues/54)) ([f14ad2f](https://github.com/rservant/speech-evaluator/commit/f14ad2fc86aa8d056f145a50e8c78a1b9a424c02))


### Performance Improvements

* defer WebSocket connection until live session starts ([#59](https://github.com/rservant/speech-evaluator/issues/59)) ([32acf64](https://github.com/rservant/speech-evaluator/commit/32acf648a5453f5e5dfa939d0a909ac5c241831d))

## [0.6.0](https://github.com/rservant/speech-evaluator/compare/v0.5.0...v0.6.0) (2026-02-27)


### Features

* replace stub detectors with real ML (BlazeFace + MoveNet via TF.js WASM) ([3acfc55](https://github.com/rservant/speech-evaluator/commit/3acfc55ebcd94ce8bf0c9789829e3bb6bbaad16a)), closes [#27](https://github.com/rservant/speech-evaluator/issues/27)

## [0.5.0](https://github.com/rservant/speech-evaluator/compare/v0.4.0...v0.5.0) (2026-02-27)


### Features

* Add iMessage notification workflow and remove outdated macOS native skill documentation. ([5c2cdaa](https://github.com/rservant/speech-evaluator/commit/5c2cdaab2a58c37b21db31a3351eedec1f358cd7))
* add stub face/pose detectors and wire into SessionManager ([#21](https://github.com/rservant/speech-evaluator/issues/21), [#22](https://github.com/rservant/speech-evaluator/issues/22), [#23](https://github.com/rservant/speech-evaluator/issues/23)) ([703398a](https://github.com/rservant/speech-evaluator/commit/703398afd33db282178926fc8821058f579d48c1)), closes [#27](https://github.com/rservant/speech-evaluator/issues/27)
* add video/audio upload endpoint with offline pipeline ([#24](https://github.com/rservant/speech-evaluator/issues/24), [#25](https://github.com/rservant/speech-evaluator/issues/25), [#26](https://github.com/rservant/speech-evaluator/issues/26)) ([4e4337b](https://github.com/rservant/speech-evaluator/commit/4e4337ba0f4e5f78a29af8925b8f9de13c180ee8))
* Establish core engineering workflows for TDD and pre-task orientation with dedicated rule documentation. ([4216125](https://github.com/rservant/speech-evaluator/commit/42161259ee5ab145d27272691b130942647017e8))
* rename application from AI Toastmasters Evaluator to AI Speech Evaluator ([a970856](https://github.com/rservant/speech-evaluator/commit/a97085692efdf94e457eb81f0e5500051c9663cb)), closes [#28](https://github.com/rservant/speech-evaluator/issues/28)
* **ui:** enlarge video preview with resize and expand toggle ([#20](https://github.com/rservant/speech-evaluator/issues/20)) ([be778d6](https://github.com/rservant/speech-evaluator/commit/be778d61ca61886c1334680706e6d6beba9d1cc9))


### Bug Fixes

* extract version into side-effect-free module for CI ([#18](https://github.com/rservant/speech-evaluator/issues/18)) ([e2e408b](https://github.com/rservant/speech-evaluator/commit/e2e408b6305f695c778d98885f83b4218afc6414))
* prevent double-click Start Speech, responsive mobile status bar, debounce consent messages ([f2e73d8](https://github.com/rservant/speech-evaluator/commit/f2e73d88d35220122208b0f32275a01f87694dc8)), closes [#29](https://github.com/rservant/speech-evaluator/issues/29) [#30](https://github.com/rservant/speech-evaluator/issues/30) [#31](https://github.com/rservant/speech-evaluator/issues/31)
