use tauri_plugin_opener::OpenerExt;

fn authorization_url(value: &str) -> Result<tauri::Url, String> {
    if value.len() > 16_384 { return Err("The identity authorization address is too long.".into()); }
    let url = tauri::Url::parse(value).map_err(|_| "The identity authorization address is invalid.")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("Identity sign-in requires HTTPS, without credentials or a fragment.".into());
    }
    let mut parameters = std::collections::HashMap::new();
    for (key, value) in url.query_pairs() {
        if parameters.insert(key.into_owned(), value.into_owned()).is_some() {
            return Err("The identity authorization address has duplicate parameters.".into());
        }
    }
    for (key, expected) in [("response_type", "code"), ("code_challenge_method", "S256"), ("redirect_uri", "draftmatter://auth/callback")] {
        if parameters.get(key).map(String::as_str) != Some(expected) {
            return Err("The identity authorization request must use DraftMatter's PKCE callback.".into());
        }
    }
    for key in ["client_id", "state", "code_challenge"] {
        if parameters.get(key).is_none_or(|value| value.is_empty()) {
            return Err("The identity authorization request is incomplete.".into());
        }
    }
    Ok(url)
}

#[tauri::command]
pub fn open_identity_authorization(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let checked = authorization_url(&url)?;
    app.opener().open_url(checked.as_str(), None::<&str>).map_err(|_| "The system browser could not be opened for sign-in.".into())
}

fn logout_url(value: &str) -> Result<tauri::Url, String> {
    if value.len() > 16_384 { return Err("The identity sign-out address is too long.".into()); }
    let url = tauri::Url::parse(value).map_err(|_| "The identity sign-out address is invalid.")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("Identity sign-out requires HTTPS, without credentials or a fragment.".into());
    }
    // The system browser confirms logout. Never put ID/access/refresh tokens in
    // its URL, OS process arguments, browser history or a post-logout redirect.
    let parameters = url.query_pairs().collect::<Vec<_>>();
    if parameters.len() != 1 || parameters[0].0 != "client_id"
        || parameters[0].1.trim().is_empty() || parameters[0].1.len() > 256
        || parameters[0].1.chars().any(char::is_control) {
        return Err("The identity sign-out address must contain only its public client identifier.".into());
    }
    Ok(url)
}

#[tauri::command]
pub fn open_identity_logout(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let checked = logout_url(&url)?;
    app.opener().open_url(checked.as_str(), None::<&str>).map_err(|_| "The system browser could not be opened for sign-out.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(endpoint: &str) -> String {
        format!("{endpoint}?response_type=code&code_challenge_method=S256&redirect_uri=draftmatter%3A%2F%2Fauth%2Fcallback&client_id=desktop&state=state&code_challenge=challenge")
    }
    #[test]
    fn allows_only_browser_pkce_authorization_with_exact_callback() {
        assert!(authorization_url(&request("https://identity.example.test/authorize")).is_ok());
        assert!(authorization_url(&request("http://127.0.0.1:8080/authorize")).is_ok());
        for endpoint in ["file:///tmp/a", "javascript:alert(1)", "http://identity.example.test", "https://user:password@example.test/a"] {
            assert!(authorization_url(&request(endpoint)).is_err());
        }
        let valid = request("https://identity.example.test/authorize");
        assert!(authorization_url(&valid.replace("S256", "plain")).is_err());
        assert!(authorization_url(&valid.replace("auth%2Fcallback", "open%2Fcallback")).is_err());
        assert!(authorization_url(&(valid.clone() + "&state=duplicate")).is_err());
        assert!(authorization_url(&(valid + "#fragment")).is_err());
    }

    #[test]
    fn logout_opens_only_a_secure_browser_address_with_a_public_client_id() {
        assert!(logout_url("https://identity.example.test/logout?client_id=draftmatter-public").is_ok());
        assert!(logout_url("http://127.0.0.1:8080/logout?client_id=draftmatter-public").is_ok());
        for endpoint in ["file:///tmp/logout", "javascript:alert(1)", "http://identity.example.test/logout", "https://user:password@identity.example.test/logout"] {
            assert!(logout_url(&format!("{endpoint}?client_id=draftmatter-public")).is_err());
        }
        let valid = "https://identity.example.test/logout?client_id=draftmatter-public";
        for extra in ["&id_token_hint=private", "&access_token=private", "&refresh_token=private", "&client_id=duplicate", "&post_logout_redirect_uri=file%3A%2F%2Fprivate", "#fragment"] {
            assert!(logout_url(&(valid.to_string() + extra)).is_err());
        }
        assert!(logout_url("https://identity.example.test/logout").is_err());
        assert!(logout_url("https://identity.example.test/logout?client_id=").is_err());
        assert!(logout_url("https://identity.example.test/logout?client_id=%0A").is_err());
    }
}
