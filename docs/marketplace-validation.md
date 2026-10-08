# Marketplace validation boundaries

Live signed-in/out detection and offer/contact flows have **not** been validated end to end across the six marketplaces. Automated tests verify data, forms and simulated integrations; they do not establish real buyer-session behavior. Public web extraction runs independently of the buyer's browser and is not evidence of their login state. The procedures below define the evidence still needed.

## Current coverage

| Marketplace          | Collection route implemented              | Contact/offer route implemented                                                      | Live buyer login and interaction validation                              |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Facebook Marketplace | Host browser workflow and evidence import | Reviewed messages with lease, identity checks, one send permit and reconciliation    | Unconfirmed; protocol tested with simulated evidence                     |
| eBay                 | Browse API adapter and browser/import     | Observed seller composer: manual copy/open; native Best Offer: platform-form handoff | Unconfirmed; API tests use mocked responses and do not prove buyer login |
| Vinted               | Navigation/import                         | Observed Ask seller: manual copy/open; native Make an offer: platform-form handoff   | Unconfirmed; current numeric discount/quota rules not verified           |
| Gumtree              | Navigation/import                         | Observed messaging: manual copy/open; external contact: Open listing                 | Unconfirmed                                                              |
| Auto Trader UK       | Navigation/import                         | Observed on-platform chat: manual copy/open; phone/email/callback: Open listing      | Unconfirmed; dealer contact modes differ                                 |
| Craigslist           | Navigation/import                         | Observed enabled CL Chat: manual copy/open; email relay/phone: Open listing          | Unconfirmed; chat is opt-in per posting                                  |

There is no automated native-offer submission adapter. A public button label alone does not establish availability; cached or extracted pages may contain controls for an unavailable item. Fresh visible-page inspection and active listing evidence remain necessary.

## Contact evidence and execution boundaries

`report_goodfinds_listing_contact` binds observed message and offer controls to a saved canonical listing, marketplace, selected browser and host/profile. The panel combines that observation with current browser access and session reports. Protected actions require signed-in evidence; explicitly observed guest routes have separate message/offer authentication requirements. Reports become unusable after thirty minutes or a host restart; denied site access, profile mismatch, expired/unknown sessions and inactive listings hide new contact actions. Existing conversation history remains accessible. Listing actions expire while the panel stays open; settings evaluates badge freshness when rendered.

Negotiate is available when a verified native offer or seller-message route is usable, and hidden when neither is usable. Native offers have their own handoff and observed currency, minimum, maximum, increment and remaining quota. An absent limits report requires checking; unknown bounds/quota stay visibly unverified and are reviewed in the native form. Exhausted quotas block offers. Offers use item-price evidence separately from delivery/protection fees. A seller message can accompany a native offer; sending that message never submits or confirms the native offer. The Facebook executor checks contact eligibility again immediately before granting its send permit.

The preferred flow is a native offer plus a personal message, using the form's observed note field when available or a separate verified seller composer. The offer_note report distinguishes embedded text support from general messaging. Offer-only and message-only routes remain available when the other cannot be used. Native submission still uses a manual platform-form handoff, so the combined flow must not be described as automated or live-validated.

Authentication remains a host-agent observation workflow, not an independently implemented cookie or network detector. The skill requires account/protected-interface evidence, an explicit guest/expired state or supported authenticated response metadata. Cookie presence, cached pages and application API credentials cannot establish buyer sign-in. Timeouts and challenges remain unknown.

## Automated verification

`tests/marketplace-actions.test.ts` exercises all six marketplaces in both browser types using simulated evidence and real isolated stores/MCP handlers. It tests handling of signed-in, signed-out, unknown and expired reports; access denial; canonical listing/revision/context binding; old/future reports; profile/site restrictions; disabled and inactive listings; messaging versus native offers; observed amount bounds, increments, currency and quota; retained history; and contact revocation before a Facebook send. It renders actual listing cards to verify visible action gating. These tests verify report consumption and protocol behaviour, not live sign-in detection or successful marketplace submissions.

Offer amount, increment and quota fixtures are synthetic evidence, not confirmation of a platform-wide discount rule. Current applicable limits must come from the actual native form. Missing regional, bundle or rounding evidence stays unknown.

## Public primary evidence reviewed

- [eBay Best Offer](https://www.ebay.co.uk/help/buying/buy-now/best-offers?id=4019): Make Offer eligibility is listing-specific; forms may request payment/postage information, autopay can collect payment on acceptance, offers concern item price, and quotas vary.
- [Vinted buying basics](https://www.vinted.co.uk/help/3/25-%CE%B1%CE%B3%CE%BF%CF%81%CE%AD%CF%82-%CE%B2%CE%AE%CE%BC%CE%B1-%CF%80%CF%81%CE%BF%CF%82-%CE%B2%CE%AE%CE%BC%CE%B1): Ask seller and Make an offer are separate routes. The reviewed primary evidence did not establish the current numeric offer floor.
- [Gumtree messages](https://www.gumtree.com/info/safety/p/trust-safety/buying/gumtree-messages/): listing Message composer and account Messages workflow. [Contact protection](https://www.gumtree.com/info/safety/p/trust-safety/protecting-users/anonymising-content-in-ads-and-replies/) distinguishes business/job email and sign-in-gated phone reveal.
- [Auto Trader dealer chat guidance](https://www.autotrader.co.uk/trade-site/static/assets/best-practice-and-user-guides/live-chat/best-practice-when-chatting-with-car-buyers.pdf): some dealers support chat and callback handling; this does not validate a particular buyer's listing.
- [Craigslist CL Chat](https://www.craigslist.org/about/help/posting/features/contact-info/chat): a buyer account and posting-level opt-in are required. [Replying by email](https://www.craigslist.org/about/Help/replying_to_posts) uses external mail; email relay is not an on-platform composer.
- [Meta messaging restrictions](https://www.facebook.com/help/messenger-app/2635156296578659/): Marketplace messaging may be restricted even for an account holder.

## Remaining live acceptance work

For each marketplace and each supported browser, identify the actual connected profile, use an existing authenticated buyer session and a separate guest profile, and retain dated non-sensitive evidence for both states. Never sign the buyer out as part of testing. Open an active eligible listing and an unavailable/ineligible example, inspect their contact routes and record fresh reports. Check that the panel exposes only the observed route and that changing profile, sign-in state or site permission withdraws it.

For native offers, open the actual form without submitting, inspect currency, item-price basis, displayed rounded minimum/maximum, increment, quota and any payment/commitment step. Test local amount validation where it can be done without sending an offer. Recheck removed/reserved listings, bundles and relevant regional variants. Unknown limits stay unknown. A later end-to-end submission test needs a specifically reviewed buyer action and resulting platform confirmation; inspection and protocol testing do not authorise seller outreach or purchases.

Live validation remains outstanding until these observations exist. Passing the automated suite or packaging the plugin does not change that status.
