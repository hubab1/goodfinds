---
name: setup
description: Introduce Goodfinds after installation and help the buyer begin their first search. Use for plugin onboarding or an explicit Goodfinds setup request.
---

Read [marketplace shopping](../marketplace-shopping/SKILL.md) and use its connected tools. If the buyer already supplied a buying request, carry that request through setup and the live search panel handoff; reuse their answers.

For setup without a buying request, show Goodfinds through [panel handoff](../marketplace-shopping/references/panel-chat-actions.md#show-the-search-at-the-right-time), reusing an existing panel or calling `open_goodfinds_panel` for its first display. Explain briefly that saved searches, listing photos and comparisons live beside the chat, and ask what they want to find. Existing searches stay available; opening setup does not start searches or change monitoring. Keep sign-in and browser choices for when the selected marketplaces need them.

If the host cannot display the panel, explain that specific limitation using [connection diagnostics](../marketplace-shopping/references/connection-diagnostics.md). A helper command does not open the host UI. Continue with the buyer's request in chat while keeping the same saved data.
