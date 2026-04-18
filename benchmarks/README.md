# Benchmarks

All benchmark-related assets live under this directory.

- `scripts/bench.ts`: benchmark/probe/generator entrypoint and implementation
- `datasets/`: benchmark inputs and reusable fixtures
- `datasets/source/`: raw local source files used to generate datasets
- `reports/`: generated evaluation reports

Common commands:

- `npm run bench`
- `npm run eval:suite`
- `npm run bench:humanlike`
- `npm run bench:date-diversity`
- `npm run bench -- probe-100 --fails`
