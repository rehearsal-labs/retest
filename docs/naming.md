# Naming and account check

Checked 29 September 2026. These are observations at the time of the check, not a reservation or trademark clearance.

| Item | Observation | Meaning |
| --- | --- | --- |
| Unscoped `retest` | Public registry returned HTTP 200, latest version `1.0.1`, description “Request driven library for testing HTTP servers”, repository `blakeembrey/retest` | Already occupied. Do not use this unscoped npm name. |
| `@rehearsal-labs/retest` | Public registry returned HTTP 404 | No publicly visible package was found. Private visibility, scope permission and publishing restrictions were not established. |
| npm organization `rehearsal-labs` | Organization page opened successfully in Chrome and listed `@rehearsal-labs/cli` | The organization already exists. A new user account named `retest` is unnecessary for the proposed scoped package. |
| Existing organization package | Organization page listed the Rehearsal CLI, version `1.0.1`, with publisher `vahagnz` | Consistent with the intended ecosystem. This alone does not establish the current operator's publishing permissions. |
| Local npm authentication | A network-enabled `npm whoami` request returned HTTP 401 Unauthorized | The local CLI could not authenticate. Organization membership and role could not be checked. |
| Registration/publication | Not attempted | Nothing was reserved or published. |

The direct organization/profile HTTP requests were blocked with HTTP 403. The organization result above comes from the actual browser page, not an inference from those blocked requests.

Use `@rehearsal-labs/retest` provisionally. The library can expose a `retest` executable when implemented; the package scope and executable name are separate choices. Keeping a scoped package does not resolve every brand or search-name collision. The older `retest/recheck-web` project is also a reason to review branding before launch.

Before publication, the owner must restore valid npm authentication and verify membership in `rehearsal-labs`. Then recheck the scoped name. Do not publish an empty placeholder simply to claim it.

## Sources

- [Unscoped package registry record](https://registry.npmjs.org/retest)
- [Proposed scoped package registry endpoint](https://registry.npmjs.org/@rehearsal-labs%2Fretest)
- [Rehearsal Labs organization](https://www.npmjs.com/org/rehearsal-labs)
- [npm scopes](https://docs.npmjs.com/about-scopes/)
- [Existing recheck-web project](https://github.com/retest/recheck-web)

npm grants a scope matching a user or organization name. Owning a scope permits a package basename that someone else has already used under a different scope. Public availability checks cannot establish that a particular account may publish.
