use anyhow::{Result, ensure};
use reqwest::{
    Client, Method, Url,
    dns::{Addrs, Name, Resolve, Resolving},
    header::{HeaderName, HeaderValue, LOCATION},
};
use serde::Deserialize;
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};

pub const MAX_BODY: usize = 64 * 1024;
const MAX_REQUEST: usize = 16 * 1024;
const MAX_CALLS: usize = 8;
const MAX_REDIRECTS: usize = 5;
const MAX_TIME: Duration = Duration::from_secs(5);

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Grant {
    allowed_hosts: Vec<String>,
}
impl Grant {
    pub fn parse(value: &serde_json::Value) -> Result<Self> {
        let grant: Self = serde_json::from_value(value.clone())?;
        ensure!(
            !grant.allowed_hosts.is_empty() && grant.allowed_hosts.len() <= 32,
            "invalid allowedHosts"
        );
        let mut seen = std::collections::BTreeSet::new();
        for host in &grant.allowed_hosts {
            ensure!(
                host.len() <= 253
                    && host == &host.to_ascii_lowercase()
                    && host.parse::<IpAddr>().is_err()
                    && host.split('.').all(|label| !label.is_empty()
                        && label.len() <= 63
                        && label.as_bytes()[0].is_ascii_alphanumeric()
                        && label
                            .as_bytes()
                            .last()
                            .is_some_and(u8::is_ascii_alphanumeric)
                        && label
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'))
                    && seen.insert(host),
                "allowedHosts requires unique exact lowercase DNS names"
            );
        }
        Ok(grant)
    }
    fn check(&self, url: &Url) -> Result<()> {
        ensure!(
            ["http", "https"].contains(&url.scheme())
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none(),
            "invalid HTTP destination"
        );
        ensure!(
            matches!(url.port_or_known_default(), Some(80 | 443)),
            "port is not allowed"
        );
        let host = url
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("missing host"))?;
        ensure!(
            self.allowed_hosts.iter().any(|allowed| allowed == host),
            "host is not allowed"
        );
        Ok(())
    }
}

// Conservative public-unicast allow policy. Deny special-use ranges, transition
// encodings and mapped IPv4, including metadata on shared address space.
fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192
                    && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] <= 0x1ff || s[1] == 0xdb8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] <= 0x0fff)
        }
    }
}
fn checked_addresses(addresses: Vec<SocketAddr>) -> Result<Addrs> {
    ensure!(
        !addresses.is_empty() && addresses.len() <= 64 && addresses.iter().all(|a| public(a.ip())),
        "DNS destination is not public"
    );
    Ok(Box::new(addresses.into_iter()))
}
struct PublicDns;
impl Resolve for PublicDns {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            // Connect to these checked addresses; retain hostname for Host,
            // SNI and certificate verification. Never resolve again at connect.
            static SLOTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> =
                std::sync::OnceLock::new();
            let permit = SLOTS
                .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
                .clone()
                .acquire_owned()
                .await?;
            let host = name.as_str().to_owned();
            let addresses = tokio::task::spawn_blocking(move || {
                use std::net::ToSocketAddrs;
                // Keep the permit inside libc DNS, even if the HTTP deadline
                // cancels the await. At most two lookups can remain outstanding.
                let _permit = permit;
                (host.as_str(), 0)
                    .to_socket_addrs()
                    .map(|a| a.take(65).collect())
            })
            .await??;
            checked_addresses(addresses).map_err(Into::into)
        })
    }
}
fn client() -> Result<Client> {
    Ok(Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(Arc::new(PublicDns))
        .http1_only()
        .pool_max_idle_per_host(0)
        .build()?)
}
async fn send(
    client: &Client,
    grant: &Grant,
    method: &str,
    destination: &str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) -> Result<(u16, Vec<u8>)> {
    ensure!(
        destination.len() <= 2048 && body.len() <= MAX_REQUEST && headers.len() <= 32,
        "request exceeds quota"
    );
    let mut url = Url::parse(destination)?;
    let mut method = Method::from_bytes(method.as_bytes())?;
    ensure!(
        [
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::HEAD
        ]
        .contains(&method),
        "method is not allowed"
    );
    let mut parsed = reqwest::header::HeaderMap::new();
    let mut size = 0;
    for (name, value) in headers {
        size += name.len() + value.len();
        ensure!(size <= 8192, "headers exceed quota");
        let name = HeaderName::from_bytes(name.as_bytes())?;
        ensure!(
            ![
                "host",
                "connection",
                "content-length",
                "transfer-encoding",
                "upgrade",
                "proxy-authorization",
                "proxy-connection",
                "te",
                "trailer",
                "keep-alive"
            ]
            .contains(&name.as_str()),
            "header is not allowed"
        );
        parsed.append(name, HeaderValue::from_str(&value)?);
    }
    let mut body = body;
    for hop in 0..=MAX_REDIRECTS {
        grant.check(&url)?;
        let mut response = client
            .request(method.clone(), url.clone())
            .headers(parsed.clone())
            .body(body.clone())
            .send()
            .await?;
        let status = response.status().as_u16();
        if [301, 302, 303, 307, 308].contains(&status) {
            ensure!(hop < MAX_REDIRECTS, "redirect limit exceeded");
            let location = response
                .headers()
                .get(LOCATION)
                .ok_or_else(|| anyhow::anyhow!("missing redirect location"))?
                .to_str()?;
            ensure!(location.len() <= 2048, "redirect exceeds quota");
            let next = url.join(location)?;
            grant.check(&next)?;
            ensure!(
                !(url.scheme() == "https" && next.scheme() != "https"),
                "TLS downgrade denied"
            );
            ensure!(
                url.origin() == next.origin() || body.is_empty(),
                "cross-origin body redirect denied"
            );
            // Drop signatures, cookies and bearer tokens on every redirect.
            parsed.clear();
            if status == 303 || ((status == 301 || status == 302) && method == Method::POST) {
                method = Method::GET;
                body.clear();
            }
            url = next;
            continue;
        }
        ensure!(
            response
                .content_length()
                .is_none_or(|n| n <= MAX_BODY as u64),
            "response exceeds quota"
        );
        let mut output = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                output.len() + chunk.len() <= MAX_BODY,
                "response exceeds quota"
            );
            output.extend_from_slice(&chunk);
        }
        return Ok((status, output));
    }
    unreachable!()
}
fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .max_blocking_threads(2)
            .enable_all()
            .build()
            .expect("network runtime")
    })
}
impl super::pirs::sandbox::network::Host for super::CallState {
    fn request(
        &mut self,
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> Result<std::result::Result<super::pirs::sandbox::network::Response, String>> {
        self.check_deadline()?;
        let Some(grant) = self.network_grant.as_ref() else {
            return Ok(Err("network capability denied".into()));
        };
        if self.network_calls >= MAX_CALLS {
            return Ok(Err("network call quota exceeded".into()));
        }
        self.network_calls += 1;
        let remaining = self
            .deadline
            .saturating_duration_since(Instant::now())
            .min(MAX_TIME);
        let result = runtime().block_on(async {
            tokio::time::timeout(remaining, async {
                send(&client()?, grant, &method, &url, headers, body).await
            })
            .await
        });
        self.check_deadline()?;
        Ok(match result {
            Ok(Ok((status, body))) => Ok(super::pirs::sandbox::network::Response { status, body }),
            // Never echo URLs, headers, bodies or transport error details.
            Ok(Err(_)) => Err("network request denied or failed".into()),
            Err(_) => Err("network request deadline exceeded".into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // A test-only resolver transports a fictional public hostname to a
    // disposable local listener. Production has no override or fixture flag.
    struct FixtureDns {
        address: SocketAddr,
    }
    impl Resolve for FixtureDns {
        fn resolve(&self, name: Name) -> Resolving {
            let address = self.address;
            let host = name.as_str().to_owned();
            Box::pin(async move {
                if host == "receiver.example" {
                    Ok(Box::new(vec![address].into_iter()) as Addrs)
                } else {
                    checked_addresses(vec!["127.0.0.1:80".parse().unwrap()]).map_err(Into::into)
                }
            })
        }
    }
    fn fixture(
        wire: Vec<u8>,
        count: usize,
        delay: Duration,
    ) -> (Client, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            for _ in 0..count {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut input = [0; 8192];
                let _ = stream.read(&mut input);
                std::thread::sleep(delay);
                let _ = stream.write_all(&wire);
            }
        });
        let client = runtime().block_on(async {
            Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .dns_resolver(Arc::new(FixtureDns { address }))
                .pool_max_idle_per_host(0)
                .build()
                .unwrap()
        });
        (client, thread)
    }
    #[test]
    fn transport_limits_and_redirects() {
        let grant = Grant::parse(
            &serde_json::json!({"allowedHosts":["receiver.example","private.example"]}),
        )
        .unwrap();
        for location in [
            "http://127.0.0.1/",
            "http://169.254.169.254/",
            "http://private.example/",
            "http://outside.example/",
        ] {
            let (client, thread) = fixture(format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes(), 1, Duration::ZERO);
            let result = runtime().block_on(send(
                &client,
                &grant,
                "GET",
                "http://receiver.example/",
                vec![],
                vec![],
            ));
            assert!(result.is_err(), "{location}");
            thread.join().unwrap();
        }
        for wire in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 65537\r\nConnection: close\r\n\r\n".to_vec(),
            [b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n10001\r\n".as_slice(), &vec![b'x'; MAX_BODY + 1], b"\r\n0\r\n\r\n"].concat(),
        ] {
            let (client, thread) = fixture(wire, 1, Duration::ZERO);
            assert!(runtime().block_on(send(&client, &grant, "GET", "http://receiver.example/", vec![], vec![])).is_err());
            thread.join().unwrap();
        }
        let (client, thread) = fixture(b"HTTP/1.1 302 Found\r\nLocation: /loop\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(), 6, Duration::ZERO);
        assert!(
            runtime()
                .block_on(send(
                    &client,
                    &grant,
                    "GET",
                    "http://receiver.example/",
                    vec![],
                    vec![]
                ))
                .is_err()
        );
        thread.join().unwrap();
        let (client, thread) = fixture(
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_vec(),
            1,
            Duration::from_millis(200),
        );
        let started = Instant::now();
        assert!(
            runtime()
                .block_on(async {
                    tokio::time::timeout(
                        Duration::from_millis(50),
                        send(
                            &client,
                            &grant,
                            "GET",
                            "http://receiver.example/",
                            vec![],
                            vec![],
                        ),
                    )
                    .await
                })
                .is_err()
        );
        assert!(started.elapsed() < Duration::from_millis(150));
        thread.join().unwrap();
        let (client, thread) = fixture(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_vec(),
            1,
            Duration::ZERO,
        );
        assert_eq!(
            runtime()
                .block_on(send(
                    &client,
                    &grant,
                    "GET",
                    "http://receiver.example/",
                    vec![],
                    vec![]
                ))
                .unwrap(),
            (200, b"ok".to_vec())
        );
        thread.join().unwrap();
    }
    #[test]
    fn callback_denies_ungranted_and_excess_calls() {
        use super::super::pirs::sandbox::network::Host;
        let limits = super::super::Limits {
            memory_bytes: 1024,
            deadline_ms: 1000,
            response_bytes: 1024,
            log_bytes: 1024,
            input_bytes: 1024,
        };
        let mut state = super::super::CallState::new(limits);
        assert_eq!(
            state
                .request("GET".into(), "http://example.com/".into(), vec![], vec![])
                .unwrap()
                .unwrap_err(),
            "network capability denied"
        );
        state.network_grant =
            Some(Grant::parse(&serde_json::json!({"allowedHosts":["example.com"]})).unwrap());
        state.network_calls = MAX_CALLS;
        assert_eq!(
            state
                .request("GET".into(), "http://example.com/".into(), vec![], vec![])
                .unwrap()
                .unwrap_err(),
            "network call quota exceeded"
        );
    }
    #[test]
    fn addresses_and_grants() {
        for ip in [
            "0.0.0.0",
            "10.1.2.3",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "100.100.100.200",
            "224.0.0.1",
            "240.0.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "::1",
            "::",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "64:ff9b::a00:1",
            "2002:a00:1::",
            "2001:db8::1",
            "2001::1",
        ] {
            assert!(!public(ip.parse().unwrap()), "{ip}");
        }
        assert!(public("93.184.215.14".parse().unwrap()));
        assert!(public("2606:4700:4700::1111".parse().unwrap()));
        assert!(
            checked_addresses(vec![
                "1.1.1.1:80".parse().unwrap(),
                "127.0.0.1:80".parse().unwrap()
            ])
            .is_err()
        );
        for hosts in [
            serde_json::json!([]),
            serde_json::json!(["*.example.com"]),
            serde_json::json!(["EXAMPLE.com"]),
            serde_json::json!(["127.0.0.1"]),
            serde_json::json!(["example.com", "example.com"]),
        ] {
            assert!(Grant::parse(&serde_json::json!({"allowedHosts":hosts})).is_err());
        }
        let grant = Grant::parse(&serde_json::json!({"allowedHosts":["example.com"]})).unwrap();
        for url in [
            "file:///etc/passwd",
            "http://example.com:8080/",
            "https://user@example.com/",
            "http://other.example.com/",
            "http://127.0.0.1/",
            "http://example.com/#fragment",
        ] {
            assert!(grant.check(&Url::parse(url).unwrap()).is_err(), "{url}");
        }
        assert!(
            grant
                .check(&Url::parse("https://example.com/").unwrap())
                .is_ok()
        );
    }
}
