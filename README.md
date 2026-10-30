# LEGO Deal Finder

[![Node tests](https://github.com/herobryyant/Lego-Deal-Finder/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/herobryyant/Lego-Deal-Finder/actions/workflows/tests.yml)

A full-stack LEGO deal finder that searches eBay listings, estimates discounts, and lets users save deals and manage watchlists.

## Tests

The project uses Node.js's built-in test runner and GitHub Actions.

- 7 unit tests covering `median` and `toListing`
- Integration smoke test covering the API, authentication, database operations, and eBay deletion webhook
- Tests run automatically on pushes and pull requests

[View unit tests](./test_datebase/test/unit/deals.test.js)  
[View integration test](./test_datebase/test/smoke.js)
