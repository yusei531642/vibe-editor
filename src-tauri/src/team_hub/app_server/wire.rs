//! Issue #1062: WebSocket-over-unix の最小フレーム実装 (RFC 6455 のサブセット)。
//!
//! codex app-server の unix socket transport は「HTTP Upgrade → 1 JSON-RPC = 1 text frame」。
//! 依存追加を避けるため (Issue #79) tokio の `UnixStream` 上に手組みする。
//! client は送信フレームを mask 必須、test の mock server は unmask で送る。

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::error::AppServerError;

/// payload サイズの上限 (DoS / 暴走防止)。app-server の JSON-RPC は十分小さい。
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

const OP_CONTINUATION: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

/// 1 本の双方向ストリーム上で WebSocket text frame を読み書きする薄いラッパ。
pub(crate) struct WsStream<S> {
    stream: S,
    rbuf: Vec<u8>,
    /// 送信フレームを mask するか (client = true, server = false)。
    mask_outgoing: bool,
}

impl<S: AsyncRead + AsyncWrite + Unpin> WsStream<S> {
    pub(crate) fn new(stream: S, mask_outgoing: bool) -> Self {
        Self {
            stream,
            rbuf: Vec::new(),
            mask_outgoing,
        }
    }

    /// client 側ハンドシェイク: GET Upgrade を送り 101 を待つ。
    /// Sec-WebSocket-Accept の検証は行わない (localhost の信頼済み socket 前提)。
    pub(crate) async fn client_handshake(&mut self) -> Result<(), AppServerError> {
        let key = base64_encode(uuid::Uuid::new_v4().as_bytes());
        let req = format!(
            "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
             Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        self.stream
            .write_all(req.as_bytes())
            .await
            .map_err(AppServerError::Io)?;
        self.stream.flush().await.map_err(AppServerError::Io)?;

        let head = self.read_http_head().await?;
        let status_line = head.lines().next().unwrap_or("");
        if !status_line.starts_with("HTTP/1.1 101") {
            return Err(AppServerError::Handshake(status_line.to_string()));
        }
        Ok(())
    }

    /// server 側ハンドシェイク (test の mock 用): リクエストを読み 101 を返す。
    #[cfg(test)]
    pub(crate) async fn server_handshake(&mut self) -> Result<(), AppServerError> {
        let _req = self.read_http_head().await?;
        let resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\
                    Connection: Upgrade\r\nSec-WebSocket-Accept: mock\r\n\r\n";
        self.stream
            .write_all(resp.as_bytes())
            .await
            .map_err(AppServerError::Io)?;
        self.stream.flush().await.map_err(AppServerError::Io)?;
        Ok(())
    }

    /// text frame を 1 本送信する。
    pub(crate) async fn write_text(&mut self, payload: &[u8]) -> Result<(), AppServerError> {
        self.write_frame(OP_TEXT, payload).await
    }

    /// text メッセージを 1 つ読む。ping には pong で応答し、close なら `None` を返す。
    /// fragmentation (continuation) も最小限ハンドルする。
    pub(crate) async fn read_text(&mut self) -> Result<Option<String>, AppServerError> {
        let mut acc: Vec<u8> = Vec::new();
        loop {
            let (opcode, fin, payload) = self.read_frame().await?;
            match opcode {
                OP_CLOSE => return Ok(None),
                OP_PING => self.write_frame(OP_PONG, &payload).await?,
                OP_PONG => {}
                OP_TEXT | OP_CONTINUATION => {
                    acc.extend_from_slice(&payload);
                    if fin {
                        return Ok(Some(String::from_utf8_lossy(&acc).into_owned()));
                    }
                }
                OP_BINARY => {
                    // app-server は text のみを使う。binary は黙って捨てる。
                    if fin {
                        acc.clear();
                    }
                }
                other => {
                    return Err(AppServerError::Protocol(format!(
                        "unexpected websocket opcode {other:#x}"
                    )))
                }
            }
        }
    }

    async fn write_frame(&mut self, opcode: u8, payload: &[u8]) -> Result<(), AppServerError> {
        let len = payload.len();
        let mask_bit = if self.mask_outgoing { 0x80u8 } else { 0 };
        let mut frame: Vec<u8> = Vec::with_capacity(len + 14);
        frame.push(0x80 | opcode); // FIN + opcode
        if len < 126 {
            frame.push(mask_bit | (len as u8));
        } else if len < 65536 {
            frame.push(mask_bit | 126);
            frame.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            frame.push(mask_bit | 127);
            frame.extend_from_slice(&(len as u64).to_be_bytes());
        }
        if self.mask_outgoing {
            let key = rand_mask();
            frame.extend_from_slice(&key);
            let start = frame.len();
            frame.extend_from_slice(payload);
            for (i, byte) in frame[start..].iter_mut().enumerate() {
                *byte ^= key[i & 3];
            }
        } else {
            frame.extend_from_slice(payload);
        }
        self.stream
            .write_all(&frame)
            .await
            .map_err(AppServerError::Io)?;
        self.stream.flush().await.map_err(AppServerError::Io)?;
        Ok(())
    }

    /// 1 フレーム読み取り、`(opcode, fin, unmasked_payload)` を返す。
    async fn read_frame(&mut self) -> Result<(u8, bool, Vec<u8>), AppServerError> {
        self.fill(2).await?;
        let b0 = self.rbuf[0];
        let b1 = self.rbuf[1];
        let fin = b0 & 0x80 != 0;
        let opcode = b0 & 0x0f;
        let masked = b1 & 0x80 != 0;
        let len0 = (b1 & 0x7f) as usize;

        let (mut header_len, payload_len) = match len0 {
            126 => {
                self.fill(4).await?;
                (4, u16::from_be_bytes([self.rbuf[2], self.rbuf[3]]) as usize)
            }
            127 => {
                self.fill(10).await?;
                let mut a = [0u8; 8];
                a.copy_from_slice(&self.rbuf[2..10]);
                (10, u64::from_be_bytes(a) as usize)
            }
            n => (2, n),
        };

        if payload_len > MAX_FRAME_BYTES {
            return Err(AppServerError::Protocol(format!(
                "websocket frame too large: {payload_len} bytes"
            )));
        }

        let mask_key = if masked {
            self.fill(header_len + 4).await?;
            let mut k = [0u8; 4];
            k.copy_from_slice(&self.rbuf[header_len..header_len + 4]);
            header_len += 4;
            Some(k)
        } else {
            None
        };

        self.fill(header_len + payload_len).await?;
        let mut payload = self.rbuf[header_len..header_len + payload_len].to_vec();
        if let Some(k) = mask_key {
            for (i, byte) in payload.iter_mut().enumerate() {
                *byte ^= k[i & 3];
            }
        }
        self.rbuf.drain(0..header_len + payload_len);
        Ok((opcode, fin, payload))
    }

    /// `rbuf` に最低 `need` バイト溜まるまでストリームから読む。
    async fn fill(&mut self, need: usize) -> Result<(), AppServerError> {
        let mut tmp = [0u8; 8192];
        while self.rbuf.len() < need {
            let n = self
                .stream
                .read(&mut tmp)
                .await
                .map_err(AppServerError::Io)?;
            if n == 0 {
                return Err(AppServerError::Closed);
            }
            self.rbuf.extend_from_slice(&tmp[..n]);
        }
        Ok(())
    }

    /// HTTP ヘッダ (`\r\n\r\n` まで) を読み取り、ヘッダ部を文字列で返す。
    async fn read_http_head(&mut self) -> Result<String, AppServerError> {
        let mut tmp = [0u8; 1024];
        loop {
            if let Some(pos) = find_crlf_crlf(&self.rbuf) {
                let head = String::from_utf8_lossy(&self.rbuf[..pos]).into_owned();
                self.rbuf.drain(0..pos + 4);
                return Ok(head);
            }
            let n = self
                .stream
                .read(&mut tmp)
                .await
                .map_err(AppServerError::Io)?;
            if n == 0 {
                return Err(AppServerError::Closed);
            }
            self.rbuf.extend_from_slice(&tmp[..n]);
            if self.rbuf.len() > 64 * 1024 {
                return Err(AppServerError::Handshake("http head too large".to_string()));
            }
        }
    }
}

fn find_crlf_crlf(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// RFC 6455 の 4 バイト masking key (暗号強度は不要なので uuid を流用し依存を増やさない)。
fn rand_mask() -> [u8; 4] {
    let b = uuid::Uuid::new_v4().into_bytes();
    [b[0], b[1], b[2], b[3]]
}

/// 標準 base64 (Sec-WebSocket-Key 用)。
fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
