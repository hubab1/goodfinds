# Adaptive interviews for any item

The current Goodfinds workflow assumes the host provides built-in web search. Use that search directly for item research; Goodfinds's MCP tools validate definitions, ask questions and save answers. Research runs in the host conversation. A separate search provider and provider-selection workflow are outside this version's scope.

## Research before choosing questions

1. Extract the item, intended use, supplied answers and consequential uncertainties. Resolve an ambiguous item before researching a narrower category. Establish whether a named model is an exact requirement, a preference or a reference; a buyer who explicitly welcomes alternatives has already answered that question.
2. Use built-in web search to identify the buying decisions relevant to this brief. Open the strongest first-party sources: manufacturer specifications for capabilities and compatibility, marketplace categories for vocabulary, and relevant buyer guidance for practical trade-offs. Category examples in the buyer-interview guide are starting points; research can introduce any supported category or observable attribute.
3. Persist a concise sourced summary in the draft/search discovery.research object: useful distinctions, units and sizing systems, plausible alternatives, meaningful price-comparison dimensions, and unresolved facts. Separate observed facts from design inference. Stop when the research supports the next useful decisions; an exhaustive product catalogue is unnecessary before asking a question.
4. Compare the proposed questions with the brief and all previous answers. Each remaining setup question must resolve a distinct uncertainty that materially changes useful results. Follow the search-setup question budget. Save a ready brief within the user’s requested scope and show an editable recap; an instruction to find the item now needs no additional save/search approval. Refresh research when an answer introduces a new branch or leaves a material factual uncertainty.

Research identifies candidate questions, rather than establishing the buyer's preferences. A feature found on a reference model is a proposed consideration until the buyer establishes its importance. Use plain language about outcomes and effort when the buyer lacks technical knowledge.

## Generate and adapt the definition

Use supported field types, stable IDs, real choices, earlier-field visibility conditions and typed matching rules. Generate schema data for the existing renderer. Put the next decisive unanswered question first, keeping visibility dependencies before their children. Preserve supplied answers and move low-impact unanswered questions to refinement.

After each answer, reconsider the remaining plan before the next interview call. When adapting a saved draft's fields or matching semantics, increment `definition.version`, preserve established field IDs and values, validate the revised definition, and save it with the latest revision. Reuse the draft ID. When an answer resolves another question's meaning, reuse that information instead of asking it again.

A question may collect intent without a matching rule. For example, a reference-model field can hold “Sage Barista Express” without imposing an exact model constraint. Suitable alternatives are assessed against the buyer's established requirements; keep each candidate's price comparison specific to its model/variant, condition and relevant package contents. Search researched model names and broader category terms so an unfamiliar model can enter after verification.

Offer “Not sure” when knowledge is genuinely uncertain, using an interview-only choice without a matching rule. Preserve the uncertainty in the draft; it does not become a product attribute requirement. Explicit no preference and unasked answers retain the main skill's distinct representations. Custom details use text, numeric values or a conditional follow-up where appropriate.

Stored drafts and searches retain discovery research, model scope, sources, queries and candidates. Read that profile and config.feedback on resumption; refresh dated research when a needed fact is stale or uncertain. Follow [platforms, location and feedback](platforms-location-feedback.md) for the exact contract, scoped memory and access checks.

Persist broad category_terms and a query_plan with exact, alias, brand, category, feature and alternative purposes. Define model-specific essential verification_checks as id/label/question and documented model_aliases as canonical/aliases. Unknown setup costs stay unknown; research-backed estimates are labelled. Refresh research when a broad result introduces a material new model rather than rejecting it solely because it was absent from the initial candidate list.
