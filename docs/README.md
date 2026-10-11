# Documentation

Public documentation serves people using or contributing to Goodfinds. It describes current behavior, architecture, repeatable verification, known limitations and actionable contribution work. These documents are tracked in Git.

Internal documentation belongs in `.local/docs/`: unpublished submission plans, exploratory research, historical audits, prompt or session notes, and project administration. `.local/` is ignored by Git. Plugin packages use explicit runtime inputs, and website deployment uploads only `website/`, so neither includes this folder. Public guides and build steps must remain usable without internal notes.

When a document mixes both audiences, keep the current rules and reproducible procedures in public documentation and move the planning or historical material into the local folder. A known limitation or an unfinished feature can still be useful to users and contributors.

## Public guides

| Topic                               | Documentation                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Overview, setup and data            | [Project README](../README.md)                                                                                  |
| Installation and distribution       | [Plugin packaging](packaging.md), [desktop installers](../installers/README.md)                                 |
| Regional behavior                   | [Regional coverage](regional-coverage.md)                                                                       |
| Integration limits and verification | [Marketplace validation](marketplace-validation.md), [regional marketplace tests](us-marketplace-validation.md) |
| Architecture and terminology        | [Server architecture](server-architecture.md), [domain vocabulary](../CONTEXT.md)                               |
| Performance and diagnostics         | [Coordination measurements](server-performance.md)                                                              |
| Interface conventions               | [UI design](ui-design.md)                                                                                       |
| Formal specification                | [Seller-send model](../formal/README.md)                                                                        |
| Contribution priorities             | [Open work](roadmap.md)                                                                                         |

The [marketplace-shopping skill](../skills/marketplace-shopping/SKILL.md) and its references are runtime instructions shipped with the plugin. They belong with the public source because users and contributors need them to understand its behavior. Asset attribution and license notices also remain public alongside their assets.
