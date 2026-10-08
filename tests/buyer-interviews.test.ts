import test from "node:test";
import assert from "node:assert/strict";
import { buyerScenarios, runBuyerTrial } from "../scripts/buyer-interview-trials.ts";
import { searchDefinitionSchema } from "@goodfinds/contracts/search-definition";

void test("buyer briefs reach review with only decisive missing setup questions", async (t) => {
  await Promise.all(
    (await buyerScenarios()).map((scenario) =>
      t.test(scenario.id, async () => {
        const result = await runBuyerTrial(scenario);
        assert.deepEqual(
          result.questions.map((field) => field.id),
          scenario.expected_setup_questions,
        );
        assert.ok(result.count <= 5, "Initial interviews should stay within the question budget");
        assert.ok(result.saved);
        for (const [id, value] of Object.entries(scenario.values))
          assert.deepEqual(
            result.saved.values[id],
            value,
            `The brief's ${id} must survive unchanged`,
          );
        for (const field of scenario.definition.fields) {
          if (
            !(field.id in scenario.values) &&
            !scenario.expected_setup_questions.includes(field.id)
          )
            assert.equal(
              result.saved.values[field.id],
              undefined,
              "An unasked preference stays absent",
            );
        }
      }),
    ),
  );
});

void test("refinements are opt-in and a lens search still skips body shutter questions", async () => {
  const lens = (await buyerScenarios()).find((scenario) => scenario.id === "camera-lens");
  assert.ok(lens);
  assert.equal((await runBuyerTrial(lens)).count, 0);
  const refined = await runBuyerTrial(lens, "refinement");
  assert.deepEqual(
    refined.questions.map((field) => field.id),
    ["condition", "accessories"],
  );
  assert.equal(refined.saved?.values["condition"], null);
  assert.equal(refined.saved?.values["shutter_count"], undefined);
  const focused = await runBuyerTrial(lens, "refinement", ["accessories"]);
  assert.deepEqual(
    focused.questions.map((field) => field.id),
    ["accessories"],
  );
  assert.equal(focused.saved?.values["condition"], undefined);
});

void test("an essential answer cannot be deferred beyond a ready setup", async () => {
  const first = (await buyerScenarios())[0];
  assert.ok(first);
  assert.equal(
    searchDefinitionSchema.safeParse({
      ...first.definition,
      fields: [
        { id: "model", label: "Model", type: "text", required: true, question_stage: "refinement" },
      ],
    }).success,
    false,
  );
});
