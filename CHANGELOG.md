# Changelog

## [0.1.0](https://github.com/gauthamchandra/agent-hivemind/compare/v0.0.1...v0.1.0) (2026-11-23)


### Features

* Alert on conditions the usage poll finds that a person must see ([#32](https://github.com/gauthamchandra/agent-hivemind/issues/32)) ([5ad7a89](https://github.com/gauthamchandra/agent-hivemind/commit/5ad7a894298e5143f98de851d912d41811cd556e))
* Alert when a connection's daily probe fails ([#51](https://github.com/gauthamchandra/agent-hivemind/issues/51)) ([ad0803b](https://github.com/gauthamchandra/agent-hivemind/commit/ad0803b4ba9d5db8ba4e85cd964fce6ed4b4b85a))
* Build indexes concurrently in no-transaction migration files ([#37](https://github.com/gauthamchandra/agent-hivemind/issues/37)) ([f9fbebb](https://github.com/gauthamchandra/agent-hivemind/commit/f9fbebb4206a62cc1b468ff620ec2121362b54f0))
* carry a message to a suspended session ([#15](https://github.com/gauthamchandra/agent-hivemind/issues/15)) ([2be6115](https://github.com/gauthamchandra/agent-hivemind/commit/2be6115fd4ab0b6bb63505a53a8300330c0e8c35))
* Hold one lock while pending migrations run ([#43](https://github.com/gauthamchandra/agent-hivemind/issues/43)) ([e4026c4](https://github.com/gauthamchandra/agent-hivemind/commit/e4026c4a1368fc61fc422923cfa55a5f4f98bea5))
* Let a live session escalate to a person with an alert ([#33](https://github.com/gauthamchandra/agent-hivemind/issues/33)) ([c9e6ecc](https://github.com/gauthamchandra/agent-hivemind/commit/c9e6eccc44e82a945b9b32d1bc28841e54e67c6a))
* Notify a webhook of alerts, once per interval, with a limit ([#35](https://github.com/gauthamchandra/agent-hivemind/issues/35)) ([c6fd783](https://github.com/gauthamchandra/agent-hivemind/commit/c6fd7833179e90153647bf8801bcff4ee1214528))
* Poll status and usage while sessions run to keep spend current ([#31](https://github.com/gauthamchandra/agent-hivemind/issues/31)) ([fe867c4](https://github.com/gauthamchandra/agent-hivemind/commit/fe867c4eaa19e6a7c80cf1d96bbad5b5a8b7305f))
* record groups and task rules before any session exists ([#2](https://github.com/gauthamchandra/agent-hivemind/issues/2)) ([d10935f](https://github.com/gauthamchandra/agent-hivemind/commit/d10935fa07d8d78f7097fb9e7abe82c165e609fa))
* Remove a closed group 90 days after it closed ([#46](https://github.com/gauthamchandra/agent-hivemind/issues/46)) ([ef269aa](https://github.com/gauthamchandra/agent-hivemind/commit/ef269aa021b4377d44b4edddd17b70c29a5d8f38))
* Run the reaper under a worker lease so one process acts ([#23](https://github.com/gauthamchandra/agent-hivemind/issues/23)) ([54bc7c8](https://github.com/gauthamchandra/agent-hivemind/commit/54bc7c86c7f30b3c9493f457be060e1c1aa8f6f0))
* start sessions on the simulated platform ([#3](https://github.com/gauthamchandra/agent-hivemind/issues/3)) ([d774856](https://github.com/gauthamchandra/agent-hivemind/commit/d774856a97839fb9003b34390909ca9a67656f10))


### Bug Fixes

* Clear a pending stop when the platform has forgotten the session ([#42](https://github.com/gauthamchandra/agent-hivemind/issues/42)) ([a2dfed8](https://github.com/gauthamchandra/agent-hivemind/commit/a2dfed88b8068f0cb0883fa57b51bd44a82a2365))
* **deps:** update dependency @electric-sql/pglite to v0.5.17 ([#49](https://github.com/gauthamchandra/agent-hivemind/issues/49)) ([1ece0ae](https://github.com/gauthamchandra/agent-hivemind/commit/1ece0ae4a00d1e54626aefe172a662200e994771))
* **deps:** update dependency umzug to v3.8.3 ([#25](https://github.com/gauthamchandra/agent-hivemind/issues/25)) ([ed6e5b1](https://github.com/gauthamchandra/agent-hivemind/commit/ed6e5b1d806e18e048f8e3afc19e3fe5b2b2d341))
* Drop the environment report from the session prompt ([#54](https://github.com/gauthamchandra/agent-hivemind/issues/54)) ([2171477](https://github.com/gauthamchandra/agent-hivemind/commit/2171477ed2b090aa89cd5935963aee18504f4e70))
* keep a full lint from reading layer-rule fixtures ([#12](https://github.com/gauthamchandra/agent-hivemind/issues/12)) ([4a0e27b](https://github.com/gauthamchandra/agent-hivemind/commit/4a0e27b3a89fadc1d4b1f9af20b7a3de669f5cc3))
* Lock a sender's tasks before its session when messaging ([#19](https://github.com/gauthamchandra/agent-hivemind/issues/19)) ([24f1264](https://github.com/gauthamchandra/agent-hivemind/commit/24f1264855f8b944d7f7e2cdf117389e091478fd))
* Stop alerting when two sessions wait on each other ([#36](https://github.com/gauthamchandra/agent-hivemind/issues/36)) ([dc70be1](https://github.com/gauthamchandra/agent-hivemind/commit/dc70be12a17c3bcd2e965824ad6c2999c45dd951))
* Track the groups a bulk lock takes in the lock-order check ([#21](https://github.com/gauthamchandra/agent-hivemind/issues/21)) ([5b32a8e](https://github.com/gauthamchandra/agent-hivemind/commit/5b32a8ed1e767a5296d1e7404b18ca214db08d2c))
* Wait for the migration lock without an open transaction ([#45](https://github.com/gauthamchandra/agent-hivemind/issues/45)) ([8afb4c5](https://github.com/gauthamchandra/agent-hivemind/commit/8afb4c5f8a06e37ec992d417144c975abbc2c749))


### Performance Improvements

* Index alerts by rule, target and notification time ([#44](https://github.com/gauthamchandra/agent-hivemind/issues/44)) ([94c93d0](https://github.com/gauthamchandra/agent-hivemind/commit/94c93d086c2b7165272956458817910a6d11f4ed))

## Changelog
