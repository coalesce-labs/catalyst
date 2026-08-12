# CAT-163 stack supervision decisions

## Keep the periodic stack timer

The 600-second launchd start remains in place. It uniquely recovers a crashed broker, monitor, or
execution-core process because those services do not each have a `KeepAlive` agent. This change
gates the timer; it does not replace crash recovery with a health-triggered dispatcher.

## Record intent in a marker

A durable, bounded marker records an operator's `catalyst-stack stop`. A plist environment value
was rejected because changing it requires rewriting and reloading the plist, so the stop command
could not record intent immediately. The marker lets supervised starts defer while a direct start
remains the obvious recovery command. Its canonical contract is documented in the catalyst-stack
reference.
