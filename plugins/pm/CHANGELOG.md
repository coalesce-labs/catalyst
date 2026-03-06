# Changelog

## [5.0.0](https://github.com/coalesce-labs/catalyst/compare/catalyst-pm-v4.0.0...catalyst-pm-v5.0.0) (2026-03-06)


### ⚠ BREAKING CHANGES

* Configuration must now be nested under 'catalyst' key

### Features

* add catalyst-pm plugin for Linear project management ([d2dc583](https://github.com/coalesce-labs/catalyst/commit/d2dc5830864009da17de35f9dfba9a591dce280d))
* **dev:** add agent-browser skill for browser automation ([#16](https://github.com/coalesce-labs/catalyst/issues/16)) ([651241b](https://github.com/coalesce-labs/catalyst/commit/651241bfe9f559fde0f6ae1566d8bed7e6616e94))
* **dev:** oneshot Linear states and config normalization ([#17](https://github.com/coalesce-labs/catalyst/issues/17)) ([c0881bb](https://github.com/coalesce-labs/catalyst/commit/c0881bb50337958a023d731bded913cf0d3f4993))
* implement config security and thoughts system enforcement ([b40bda8](https://github.com/coalesce-labs/catalyst/commit/b40bda89dbdd3213d3c5ece2866eec7f52c72f21))
* **linear:** add configurable stateMap for portable state transitions ([#15](https://github.com/coalesce-labs/catalyst/issues/15)) ([371e1d5](https://github.com/coalesce-labs/catalyst/commit/371e1d5dd7c196c2476c28eb873b367d072bb219))
* migrate to HumanLayer profiles and update PM agents to Opus ([#7](https://github.com/coalesce-labs/catalyst/issues/7)) ([1cdbcdd](https://github.com/coalesce-labs/catalyst/commit/1cdbcdd3487422817509b87dbaa9603ad005914b))
* **pm:** add context engineering adoption tracking dashboard ([53accc3](https://github.com/coalesce-labs/catalyst/commit/53accc3948f14f02d9c73da8bec63908bc13022c))
* **pm:** add foundational agents and report templates ([1e3a033](https://github.com/coalesce-labs/catalyst/commit/1e3a03397dd7c4eee169a55c62b8235a90c74852))
* **pm:** register all PM reporting commands in plugin.json ([02b6e5c](https://github.com/coalesce-labs/catalyst/commit/02b6e5cc9699949625cdfb8d9e45664177bf5fd0))
* refresh workflow commands with new commands, model tiers, and agent teams ([#10](https://github.com/coalesce-labs/catalyst/issues/10)) ([10a010a](https://github.com/coalesce-labs/catalyst/commit/10a010a51126a8ad9485c37ae6fcb92a4156e8ee))


### Bug Fixes

* correct linearis CLI syntax across all agents and commands ([63ff171](https://github.com/coalesce-labs/catalyst/commit/63ff171dfabdc45c32c94b7e12c8c2aea95bcf06))
* **linearis:** correct --team flag docs and add UUID resolution ([#18](https://github.com/coalesce-labs/catalyst/issues/18)) ([050205c](https://github.com/coalesce-labs/catalyst/commit/050205cb0d207096efd3bf5a48bec2acc0c41566))
* remove invalid category field from catalyst-pm plugin manifest ([c9caea7](https://github.com/coalesce-labs/catalyst/commit/c9caea7af3839df2f0375448277ebf141d97a19a))
* use namespaced agent names in PM commands ([bdf3f8d](https://github.com/coalesce-labs/catalyst/commit/bdf3f8db97819d65a1225f18fe2361ee266f9636))


### Miscellaneous Chores

* bump versions for breaking config namespace change ([9a3f63b](https://github.com/coalesce-labs/catalyst/commit/9a3f63b70c119f7a019116788e6ba0c65b32aa04))

## Changelog
