//! Official eBay Browse API evidence. Application credentials never enter saved workspaces.
use crate::{
    contracts,
    error::{Error, Result},
    util::{iso, now},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use regex::Regex;
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use std::{path::Path, sync::LazyLock, time::Duration};
use tokio::sync::Mutex;
use url::Url;
const API: &str = "https://api.ebay.com";
const NOTE: &str = "API evidence, not a completed inspection. Verify attributes, availability, complete costs and every image before importing an alert candidate. Use listing_id for the canonical observation ID; item_id is the API identifier. Prices for a variation apply only to that verified variation. Buyer browser sign-in is separate from this application token.";
struct Token {
    value: String,
    expires: i64,
}
pub struct EbayClient {
    client: Client,
    client_id: Option<String>,
    client_secret: Option<String>,
    cached: Mutex<Option<Token>>,
    origin: String,
}
static EBAY: LazyLock<Result<EbayClient>> = LazyLock::new(|| {
    EbayClient::new(
        std::env::var("GOODFINDS_EBAY_CLIENT_ID").ok(),
        std::env::var("GOODFINDS_EBAY_CLIENT_SECRET").ok(),
    )
});
fn api_error(message: impl Into<String>) -> Error {
    Error::new("external_service_error", message)
}
fn http_error(_: reqwest::Error) -> Error {
    api_error("eBay request could not complete. Check the network connection and retry.")
}
impl EbayClient {
    pub fn new(client_id: Option<String>, client_secret: Option<String>) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(http_error)?,
            client_id,
            client_secret,
            cached: Mutex::new(None),
            origin: API.into(),
        })
    }
    pub fn configured(&self) -> bool {
        self.client_id.as_ref().is_some_and(|s| !s.is_empty())
            && self.client_secret.as_ref().is_some_and(|s| !s.is_empty())
    }
    async fn token(&self) -> Result<String> {
        if !self.configured() {
            return Err(api_error(
                "eBay Browse is not configured. Set GOODFINDS_EBAY_CLIENT_ID and GOODFINDS_EBAY_CLIENT_SECRET on the server; do not paste secrets into chat. Browser search links remain available.",
            ));
        }
        let mut cached = self.cached.lock().await;
        if let Some(token) = cached.as_ref()
            && token.expires > now()
        {
            return Ok(token.value.clone());
        }
        let credentials = STANDARD.encode(format!(
            "{}:{}",
            self.client_id.as_deref().unwrap_or(""),
            self.client_secret.as_deref().unwrap_or("")
        ));
        let response=self.client.post(format!("{}/identity/v1/oauth2/token",self.origin)).header("Authorization",format!("Basic {credentials}")).header("Content-Type","application/x-www-form-urlencoded").body("grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope").send().await.map_err(http_error)?;
        if !response.status().is_success() {
            return Err(api_error(
                "eBay application authentication failed. Check the server's production credentials and API access.",
            ));
        }
        let data: Value = response
            .json()
            .await
            .map_err(|_| api_error("eBay returned invalid authentication data."))?;
        let value = data["access_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| api_error("eBay returned invalid authentication data."))?;
        let expires = data["expires_in"]
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0.)
            .ok_or_else(|| api_error("eBay returned invalid authentication data."))?;
        let token = Token {
            value: value.into(),
            expires: now()
                .saturating_add(((expires - 60.).max(0.) * 1000.).min(i64::MAX as f64) as i64),
        };
        let result = token.value.clone();
        *cached = Some(token);
        Ok(result)
    }
    async fn get(&self, path: &str, marketplace: &str) -> Result<Value> {
        tokio::time::timeout(Duration::from_secs(20), async {
            let token = self.token().await?;
            let response = self
                .client
                .get(format!("{}/buy/browse/v1/{path}", self.origin))
                .bearer_auth(token)
                .header("X-EBAY-C-MARKETPLACE-ID", marketplace)
                .send()
                .await
                .map_err(http_error)?;
            if response.status() == StatusCode::UNAUTHORIZED {
                *self.cached.lock().await = None;
            }
            if !response.status().is_success() {
                return Err(api_error(
                    if response.status() == StatusCode::TOO_MANY_REQUESTS {
                        "eBay API quota reached. Retry later; this check did not complete.".into()
                    } else {
                        format!(
                            "eBay lookup failed ({}). This check did not complete.",
                            response.status().as_u16()
                        )
                    },
                ));
            }
            response
                .json()
                .await
                .map_err(|_| api_error("eBay returned invalid listing data."))
        })
        .await
        .map_err(|_| api_error("eBay lookup timed out. This check did not complete."))?
    }
    pub async fn search(&self, input: &Value) -> Result<Value> {
        let args = contracts::parse("ebaySearchSchema", input)?;
        let query = args["query"].as_str().unwrap();
        let marketplace = args["marketplace"].as_str().unwrap();
        let limit = args["limit"].as_u64().unwrap();
        let offset = args["offset"].as_u64().unwrap();
        let params = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("q", query)
            .append_pair("limit", &limit.to_string())
            .append_pair("offset", &offset.to_string())
            .append_pair("filter", "buyingOptions:{FIXED_PRICE}")
            .append_pair("fieldgroups", "EXTENDED")
            .finish();
        let data = self
            .get(&format!("item_summary/search?{params}"), marketplace)
            .await?;
        if !data.is_object() {
            return Err(api_error("eBay returned invalid search data."));
        }
        let empty = vec![];
        let items = match data.get("itemSummaries") {
            Some(items) => items
                .as_array()
                .ok_or_else(|| api_error("eBay returned invalid search results."))?,
            None => &empty,
        };
        if data.get("total").is_some_and(|v| !v.is_number())
            || data.get("next").is_some_and(|v| !v.is_string())
        {
            return Err(api_error("eBay returned invalid pagination data."));
        }
        let evidence: Vec<_> = items.iter().map(ebay_evidence).collect::<Result<_>>()?;
        let has_more = data["next"].as_str().is_some_and(|s| !s.is_empty());
        Ok(
            json!({"source":"ebay","query":query,"marketplace":marketplace,"checked_at":iso(now()),"offset":offset,"returned_count":items.len(),"total":data["total"],"has_more":has_more,"pagination_complete":!has_more&&offset==0,"items":evidence}),
        )
    }
    pub async fn item(&self, input: &Value) -> Result<Value> {
        let args = contracts::parse("ebayItemSchema", input)?;
        let item_id = args["item_id"].as_str().unwrap();
        let raw = self
            .get(
                &format!("item/{}", item_id.replace('|', "%7C")),
                args["marketplace"].as_str().unwrap(),
            )
            .await?;
        let item = ebay_evidence(&raw)?;
        if item["item_id"] != args["item_id"] {
            return Err(api_error("eBay returned a different item"));
        }
        Ok(item)
    }
}
pub fn configured() -> bool {
    EBAY.as_ref().is_ok_and(EbayClient::configured)
}
pub async fn command(_root: &Path, tool: &str, args: &Value) -> Result<Value> {
    let client = EBAY.as_ref().map_err(Clone::clone)?;
    match tool {
        "search_goodfinds_ebay" | "search_ebay" => client.search(args).await,
        "get_goodfinds_ebay_listing" | "get_ebay_listing" => client.item(args).await,
        _ => Err(Error::validation("Unknown eBay action")),
    }
}
pub fn price_minor(value: &str, currency: &str) -> Option<i64> {
    if !["GBP", "USD", "EUR", "CAD", "AUD", "NZD", "JPY"].contains(&currency) {
        return None;
    }
    let captures = Regex::new(r"^([0-9]+)(?:\.([0-9]+))?$")
        .unwrap()
        .captures(value)?;
    let major = captures.get(1)?.as_str().parse::<u128>().ok()?;
    let places = if currency == "JPY" { 0 } else { 2 };
    let fraction = captures.get(2).map(|s| s.as_str()).unwrap_or("");
    if fraction
        .get(places..)
        .is_some_and(|tail| tail.bytes().any(|c| c != b'0'))
    {
        return None;
    }
    let decimal = &fraction[..fraction.len().min(places)];
    let minor = if decimal.is_empty() {
        0
    } else {
        decimal.parse::<u128>().ok()? * 10u128.pow((places - decimal.len()) as u32)
    };
    let amount = major
        .checked_mul(10u128.pow(places as u32))?
        .checked_add(minor)?;
    if amount > 9_007_199_254_740_991 {
        return None;
    }
    Some(amount as i64)
}
fn string(value: &Value, key: &str, required: bool) -> Result<()> {
    if (required || value.get(key).is_some()) && !value[key].is_string() {
        return Err(api_error(format!("eBay item has an invalid {key}")));
    }
    Ok(())
}
fn nested_strings(value: &Value, keys: &[&str], required: &[&str]) -> Result<Value> {
    if !value.is_object() {
        return Err(api_error("eBay item has an invalid nested object"));
    }
    let mut clean = json!({});
    for key in keys {
        string(value, key, required.contains(key))?;
        if let Some(v) = value.get(key) {
            clean[*key] = v.clone();
        }
    }
    Ok(clean)
}
pub fn ebay_evidence(input: &Value) -> Result<Value> {
    if !input.is_object() {
        return Err(api_error("eBay returned an invalid item"));
    }
    let mut item = input.clone();
    for key in ["itemId", "title", "itemWebUrl"] {
        string(&item, key, true)?;
    }
    let id = item["itemId"].as_str().unwrap().to_owned();
    if !Regex::new(r"^v1\|[0-9]+\|[0-9]+$").unwrap().is_match(&id) {
        return Err(api_error("eBay item ID is invalid"));
    }
    let url = Url::parse(item["itemWebUrl"].as_str().unwrap())
        .map_err(|_| api_error("Unexpected eBay listing URL"))?;
    if !crate::listings::source_url("ebay", url.as_str()) {
        return Err(api_error("Unexpected eBay listing URL"));
    }
    let parts: Vec<_> = id.split('|').collect();
    let listing_id = parts[1];
    let variation = parts[2];
    if Regex::new(r"^/itm/(?:[^/]+/)?([0-9]+)/?$")
        .unwrap()
        .captures(url.path())
        .is_none_or(|c| c.get(1).is_none_or(|m| m.as_str() != listing_id))
    {
        return Err(api_error("eBay listing ID and URL disagree"));
    }
    if let Some(price) = item.get("price") {
        item["price"] = nested_strings(price, &["value", "currency"], &["value", "currency"])?;
    }
    if item.get("buyingOptions").is_some_and(|v| {
        v.as_array()
            .is_none_or(|a| a.iter().any(|v| !v.is_string()))
    }) {
        return Err(api_error("eBay item buying options are invalid"));
    }
    string(&item, "condition", false)?;
    if let Some(location) = item.get("itemLocation") {
        item["itemLocation"] = nested_strings(location, &["city", "country", "postalCode"], &[])?;
    }
    if let Some(image) = item.get("image") {
        let image = nested_strings(image, &["imageUrl"], &["imageUrl"])?;
        Url::parse(image["imageUrl"].as_str().unwrap())
            .map_err(|_| api_error("Invalid eBay image URL"))?;
        item["image"] = image;
    }
    if let Some(images) = item.get("additionalImages") {
        let mut cleaned = Vec::new();
        for image in images
            .as_array()
            .ok_or_else(|| api_error("Invalid eBay additional images"))?
        {
            let image = nested_strings(image, &["imageUrl"], &["imageUrl"])?;
            Url::parse(image["imageUrl"].as_str().unwrap())
                .map_err(|_| api_error("Invalid eBay image URL"))?;
            cleaned.push(image);
        }
        item["additionalImages"] = json!(cleaned);
    }
    if let Some(seller) = item.get("seller") {
        let mut clean = nested_strings(seller, &["username", "feedbackPercentage"], &[])?;
        if let Some(score) = seller.get("feedbackScore") {
            if !score.is_number() {
                return Err(api_error("Invalid eBay feedback score"));
            }
            clean["feedbackScore"] = score.clone();
        }
        item["seller"] = clean;
    }
    let fixed = item["buyingOptions"]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v == "FIXED_PRICE"));
    let mut images = Vec::new();
    if let Some(image) = item["image"]["imageUrl"].as_str() {
        images.push(image.to_owned());
    }
    for image in item["additionalImages"].as_array().into_iter().flatten() {
        images.push(image["imageUrl"].as_str().unwrap().to_owned());
    }
    Ok(
        json!({"item_id":id,"listing_id":listing_id,"variation_id":if variation=="0"{None}else{Some(variation)},"title":item["title"],"url":item["itemWebUrl"],"source":"ebay","price_minor":if fixed{price_minor(item["price"]["value"].as_str().unwrap_or(""),item["price"]["currency"].as_str().unwrap_or(""))}else{None},"currency":item["price"]["currency"],"price_kind":if fixed{"asking"}else{"auction_or_unknown"},"condition_text":item["condition"],"location":item["itemLocation"],"images":images,"seller":item["seller"],"raw":item,"note":NOTE}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    fn item() -> Value {
        json!({"itemId":"v1|123456789|0","title":"Example item","itemWebUrl":"https://www.ebay.co.uk/itm/123456789","price":{"value":"12.34","currency":"GBP"},"buyingOptions":["FIXED_PRICE"],"seller":{"username":"Example seller","feedbackScore":4,"extra":"ignored"}})
    }
    #[test]
    fn decimal_prices_and_api_identity_are_not_inferred() {
        assert_eq!(price_minor("12.3400", "GBP"), Some(1234));
        assert_eq!(price_minor("12.3401", "GBP"), None);
        assert_eq!(price_minor("1200.00", "JPY"), Some(1200));
        assert_eq!(price_minor("1.01", "JPY"), None);
        assert_eq!(price_minor("9007199254740992", "JPY"), None);
        assert_eq!(price_minor("-1", "USD"), None);
        assert_eq!(price_minor("1", "UNKNOWN"), None);
        let mut v = item();
        assert_eq!(ebay_evidence(&v).unwrap()["price_minor"], 1234);
        assert!(
            ebay_evidence(&v).unwrap()["raw"]["seller"]
                .get("extra")
                .is_none()
        );
        v["buyingOptions"] = json!(["AUCTION"]);
        assert!(ebay_evidence(&v).unwrap()["price_minor"].is_null());
        v["itemWebUrl"] = json!("https://www.ebay.co.uk/itm/987654321");
        assert!(ebay_evidence(&v).is_err());
        v["itemWebUrl"] = json!("https://ebay.co.uk.invalid/itm/123456789");
        assert!(ebay_evidence(&v).is_err());
    }
    async fn server(
        responses: Vec<(u16, Value)>,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buffer = [0; 4096];
                    let n = stream.read(&mut buffer).await.unwrap();
                    bytes.extend_from_slice(&buffer[..n]);
                    if n == 0 || bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                requests.push(String::from_utf8_lossy(&bytes).into_owned());
                let body = body.to_string();
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            }
            requests
        });
        (origin, task)
    }
    #[tokio::test]
    async fn requests_cache_tokens_and_preserve_pagination() {
        let (origin, requests) = server(vec![
            (200, json!({"access_token":"test-token","expires_in":3600})),
            (
                200,
                json!({"itemSummaries":[item()],"total":2,"next":"https://api.ebay.com/next"}),
            ),
            (200, json!({"itemSummaries":[],"total":2})),
            (200, item()),
        ])
        .await;
        let mut client =
            EbayClient::new(Some("test-id".into()), Some("test-secret".into())).unwrap();
        client.origin = origin;
        let first = client
            .search(&json!({"query":"Example item"}))
            .await
            .unwrap();
        assert_eq!(first["has_more"], true);
        assert_eq!(first["pagination_complete"], false);
        let second = client
            .search(&json!({"query":"Example item","offset":20}))
            .await
            .unwrap();
        assert_eq!(second["has_more"], false);
        assert_eq!(second["pagination_complete"], false);
        assert_eq!(
            client
                .item(&json!({"item_id":"v1|123456789|0"}))
                .await
                .unwrap()["listing_id"],
            "123456789"
        );
        let requests = requests.await.unwrap();
        assert!(requests[0].starts_with("POST /identity/v1/oauth2/token"));
        assert!(requests[1].contains("buyingOptions%3A%7BFIXED_PRICE%7D"));
        assert!(
            requests[1]
                .to_lowercase()
                .contains("authorization: bearer test-token")
        );
        assert!(requests[3].contains("item/v1%7C123456789%7C0"));
    }
    #[tokio::test]
    async fn unauthorized_invalidates_token_and_quota_failure_stays_incomplete() {
        let (origin, requests) = server(vec![
            (200, json!({"access_token":"test-token","expires_in":3600})),
            (401, json!({})),
            (
                200,
                json!({"access_token":"new-test-token","expires_in":3600}),
            ),
            (429, json!({})),
        ])
        .await;
        let mut client =
            EbayClient::new(Some("test-id".into()), Some("test-secret".into())).unwrap();
        client.origin = origin;
        assert!(
            client
                .search(&json!({"query":"Example"}))
                .await
                .unwrap_err()
                .message
                .contains("401")
        );
        assert!(
            client
                .search(&json!({"query":"Example"}))
                .await
                .unwrap_err()
                .message
                .contains("quota")
        );
        let requests = requests.await.unwrap();
        assert!(requests[2].starts_with("POST /identity/v1/oauth2/token"));
    }
    #[tokio::test]
    async fn no_credentials_never_attempts_a_request() {
        let client = EbayClient::new(None, None).unwrap();
        assert!(!client.configured());
        let error = client
            .search(&json!({"query":"Example"}))
            .await
            .unwrap_err();
        assert!(error.message.contains("not configured"));
    }
}
