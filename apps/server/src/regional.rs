//! Regional hints are read-only suggestions; saved and per-search choices win.
use crate::{
    contracts,
    error::{Error, Result},
};
use serde_json::{Value, json};
use std::sync::LazyLock;

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn valid(schema: &str, value: &Value) -> bool {
    contracts::parse(schema, value).is_ok()
}
pub fn preserve_market(previous: &Value, next: &mut Value) {
    if let Some(saved) = previous["market"].as_object() {
        let mut market = saved.clone();
        if let Some(explicit) = next["market"].as_object() {
            market.extend(explicit.clone());
        }
        next["market"] = Value::Object(market);
    }
}
pub fn host_hints(meta: &Value) -> Value {
    let mut hints = json!({});
    let locale = meta.get("openai/locale").unwrap_or(&meta["webplus/i18n"]);
    if valid("localeSchema", locale) {
        hints["locale"] = locale.clone();
    }
    let country = json!(s(&meta["openai/userLocation"]["country"]).to_uppercase());
    if valid("countrySchema", &country) {
        hints["country"] = country;
    }
    hints
}
fn locale_country(locale: &Value) -> Option<String> {
    if !valid("localeSchema", locale) {
        return None;
    }
    for part in s(locale).split('-').skip(1) {
        if part.len() == 1 {
            break;
        }
        if part.len() == 2 && part.bytes().all(|b| b.is_ascii_alphabetic()) {
            return Some(part.to_uppercase());
        }
    }
    None
}
fn choose(key: &str, explicit: &Value, saved: &Value, sources: &mut Value) -> Value {
    for (value, source) in [(explicit, "explicit"), (saved, "saved")] {
        if !s(&value[key]).is_empty() {
            sources[key] = json!(source);
            return value[key].clone();
        }
    }
    Value::Null
}
pub fn domain(source: &str, country: &str, locale: &str) -> Option<String> {
    let data = contracts::data("REGIONAL_MARKETS");
    let language = locale.split('-').next().unwrap_or("").to_lowercase();
    data["languageDomains"][source][format!("{language}-{country}")]
        .as_str()
        .or_else(|| data["domains"][source][country].as_str())
        .or_else(|| data["domains"][source]["*"].as_str())
        .map(String::from)
}
pub fn source_domains(source: &str) -> Vec<String> {
    let data = contracts::data("REGIONAL_MARKETS");
    ["domains", "languageDomains"]
        .iter()
        .flat_map(|key| {
            data[key][source]
                .as_object()
                .into_iter()
                .flat_map(|map| map.values())
                .filter_map(|v| v.as_str().map(String::from))
        })
        .collect()
}
pub fn home_url(source: &str, country: &str, locale: &str) -> Option<String> {
    let domain = domain(source, country, locale)?;
    let prefix = if source == "poshmark"
        || ["benl.", "befr.", "cafr."]
            .iter()
            .any(|p| domain.starts_with(p))
    {
        ""
    } else {
        "www."
    };
    let path = if source == "facebook_marketplace" {
        "marketplace/"
    } else if source == "depop" && country == "GB" {
        "gb/"
    } else {
        ""
    };
    Some(format!("https://{prefix}{domain}/{path}"))
}
pub fn search_url(source: &str, country: &str, locale: &str) -> Option<String> {
    let home = home_url(source, country, locale)?;
    if source == "depop" {
        return Some("https://www.depop.com/search/?q=".to_string());
    }
    let path = match source {
        "facebook_marketplace" => "search/?query=",
        "ebay" => "sch/i.html?_nkw=&LH_BIN=1",
        "vinted" => "catalog?search_text=",
        "gumtree" => "search?search_category=all&q=",
        "autotrader" => "car-search",
        "cargurus" => "Cars/spt-used-cars",
        "cars_com" => "shopping/",
        "autotrader_us" => "cars-for-sale",
        "poshmark" => "search?query=&type=listings",
        "mercari" => "search/?keyword=",
        _ => "",
    };
    Some(format!("{home}{path}"))
}
pub fn resolve(config: &Value, explicit: &Value, hints: &Value, category: &str) -> Value {
    let saved = &config["regional_preferences"];
    let data = contracts::data("REGIONAL_MARKETS");
    let mut sources =
        json!({"country":"unknown","currency":"unknown","locale":"unknown","fulfilment":"default"});
    let mut locale = choose("locale", explicit, saved, &mut sources);
    if locale.is_null() && valid("localeSchema", &hints["locale"]) {
        locale = hints["locale"].clone();
        sources["locale"] = json!("hint");
    }
    let mut country = choose("country", explicit, saved, &mut sources);
    if country.is_null() && valid("countrySchema", &config["location"]["country"]) {
        country = config["location"]["country"].clone();
        sources["country"] = json!("location");
    }
    let hinted = json!(s(&hints["country"]).to_uppercase());
    if country.is_null() && valid("countrySchema", &hinted) {
        country = hinted;
        sources["country"] = json!("hint");
    }
    if country.is_null()
        && let Some(region) = locale_country(&locale)
    {
        country = json!(region);
        sources["country"] = json!("locale");
    }
    let mut currency = choose("currency", explicit, saved, &mut sources);
    if currency.is_null() && !data["currencies"][s(&country)].is_null() {
        currency = data["currencies"][s(&country)].clone();
        sources["currency"] = json!("country");
    }
    let mut fulfilment = choose("fulfilment", explicit, saved, &mut sources);
    if fulfilment.is_null() {
        fulfilment = json!("either");
    }
    let words: Vec<String> = category
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphabetic())
        .map(String::from)
        .collect();
    // Keep the shared table's explicit precedence rather than serde's key order.
    let group = ["fashion", "vehicle", "rental"]
        .into_iter()
        .find(|key| {
            data["categories"][key]
                .as_array()
                .is_some_and(|items| items.iter().any(|v| words.iter().any(|word| word == s(v))))
        })
        .unwrap_or("general");
    let marketplaces: Vec<Value> = if country.is_null() {
        vec![]
    } else {
        data["countryRecommendations"][s(&country)][group]
            .as_array()
            .or_else(|| data["recommendations"][group].as_array())
            .into_iter()
            .flatten()
            .filter_map(|id| {
                let id = s(id);
                if config["platforms"][id]["enabled"] == false {
                    return None;
                }
                if group != "rental"
                    && !data["fulfilment"][s(&fulfilment)]
                        .as_array()
                        .is_some_and(|items| items.iter().any(|v| v == id))
                {
                    return None;
                }
                search_url(id, s(&country), s(&locale)).map(|url| json!({"id":id,"url":url}))
            })
            .collect()
    };
    let mut needs = vec![];
    if country.is_null() {
        needs.push("country");
    }
    if currency.is_null() {
        needs.push("currency");
    }
    json!({"country":country,"currency":currency,"locale":locale,"fulfilment":fulfilment,"sources":sources,"marketplaces":marketplaces,"needs":needs})
}
pub fn localize_template(template: &Value, currency: &str) -> Value {
    static FORMATS: LazyLock<Value> = LazyLock::new(|| {
        serde_json::from_str(include_str!("currency_formats.json")).expect("currency formats")
    });
    let mut next = template.clone();
    next["price"]["currency"] = json!(currency);
    let period = s(&next["price"]["period"]).to_owned();
    if let Some(fields) = next["fields"].as_array_mut() {
        for field in fields {
            if !["price_minor", "total_cash_cost_minor"].contains(&s(&field["match"]["attribute"]))
            {
                continue;
            }
            field["display_divisor"] =
                json!(10_u64.pow(FORMATS[currency]["digits"].as_u64().unwrap_or(2) as u32));
            field["unit"] = json!(format!(
                "{currency}{}",
                if period == "once" {
                    String::new()
                } else {
                    format!(" / {period}")
                }
            ));
        }
    }
    next
}
pub fn new_search_defaults(config: &Value, search: &mut Value) -> Result<()> {
    let context = resolve(
        config,
        &search["market"],
        &Value::Null,
        s(&search["definition"]["category"]),
    );
    let mut market = search.get("market").cloned().unwrap_or(json!({}));
    for key in ["country", "locale", "fulfilment"] {
        if market.get(key).is_none() && !context[key].is_null() {
            market[key] = context[key].clone();
        }
    }
    search["market"] = market;
    if !context["country"].is_null()
        && let Some(markets) = search["marketplaces"].as_array()
    {
        let unsupported: Vec<&str> = markets
            .iter()
            .map(s)
            .filter(|id| search_url(id, s(&context["country"]), s(&context["locale"])).is_none())
            .collect();
        if !unsupported.is_empty() {
            return Err(Error::validation(format!(
                "These marketplaces have no supported route for {}: {}. Use this country's recommended marketplaces or change the shopping country.",
                s(&context["country"]),
                unsupported.join(", ")
            )));
        }
    }
    if search.get("marketplaces").is_none() && !context["country"].is_null() {
        let ids: Vec<Value> = context["marketplaces"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|m| m["id"].clone())
            .collect();
        if ids.is_empty() {
            return Err(Error::validation(
                "No existing marketplace matches this country and delivery preference. Choose a marketplace or change the search scope.",
            ));
        }
        search["marketplaces"] = json!(ids);
    }
    Ok(())
}
pub fn search_routes(config: &Value, search: &Value) -> Value {
    let region = resolve(config, &search["market"], &Value::Null, "");
    let markets = search
        .get("marketplaces")
        .cloned()
        .unwrap_or(json!(["facebook_marketplace"]));
    json!(markets.as_array().into_iter().flatten().map(|id| json!({"id":id,"url":search_url(s(id),s(&region["country"]),s(&region["locale"]))})).collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hints_are_optional_and_do_not_override_explicit_or_saved_choices() {
        let saved = json!({"regional_preferences":{"country":"GB","currency":"EUR"}});
        let hinted = resolve(
            &saved,
            &json!({}),
            &json!({"locale":"en-US","country":"US"}),
            "clothing",
        );
        assert_eq!(hinted["country"], "GB");
        assert_eq!(hinted["currency"], "EUR");
        assert_eq!(
            resolve(&saved, &json!({"currency":"USD"}), &Value::Null, "")["currency"],
            "USD"
        );
        assert!(
            resolve(&json!({}), &Value::Null, &json!({"locale":"en"}), "")["currency"].is_null()
        );
        assert!(locale_country(&json!("en-u-rg-uszzzz")).is_none());
        assert_eq!(locale_country(&json!("zh-Hant-TW")), Some("TW".into()));
    }
    #[test]
    fn regional_recommendations_and_evidence_domains_share_the_registry() {
        let region = resolve(
            &json!({}),
            &json!({"country":"DE","fulfilment":"delivery"}),
            &Value::Null,
            "clothing",
        );
        assert_eq!(
            region["marketplaces"],
            json!([
                {"id":"vinted","url":"https://www.vinted.de/catalog?search_text="},
                {"id":"ebay","url":"https://www.ebay.de/sch/i.html?_nkw=&LH_BIN=1"}
            ])
        );
        assert!(search_url("ebay", "PT", "pt-PT").is_none());
        assert!(search_url("vinted", "CA", "en-CA").is_none());
        assert_eq!(domain("ebay", "BE", "fr-BE"), Some("befr.ebay.be".into()));
        assert!(crate::listings::source_url(
            "ebay",
            "https://www.ebay.it/itm/123"
        ));
        assert!(crate::listings::source_url(
            "vinted",
            "https://www.vinted.com.au/items/123-coat"
        ));
        assert!(!crate::listings::source_url(
            "ebay",
            "https://www.ebay.it.attacker.example/itm/123"
        ));
    }
    #[test]
    fn currency_templates_and_saved_values_remain_independent() {
        let template = &contracts::data("templates")[0];
        for (currency, divisor) in [("EUR", 100), ("JPY", 1), ("KWD", 1000)] {
            let next = localize_template(template, currency);
            let field = next["fields"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["match"]["attribute"] == "price_minor")
                .unwrap();
            assert_eq!(field["display_divisor"], divisor);
            assert_eq!(next["price"]["currency"], currency);
        }
        let mut search = json!({"definition":{"category":"clothing","price":{"currency":"EUR"}},"values":{"budget":50000}});
        new_search_defaults(&json!({"regional_preferences":{"country":"US","currency":"USD","fulfilment":"delivery"}}), &mut search).unwrap();
        assert_eq!(search["definition"]["price"]["currency"], "EUR");
        assert_eq!(search["values"]["budget"], 50000);
        assert_eq!(
            search["marketplaces"],
            json!(["poshmark", "depop", "mercari", "ebay"])
        );
    }
}
