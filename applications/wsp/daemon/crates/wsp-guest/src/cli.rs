// SPDX-License-Identifier: AGPL-3.0-only
//! The command line kind: the host runs the verb and streams what it printed, each piece on the stream it belongs
//! to, and the exit frame is what this process exits with.

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use wsp_frames::{GuestCliMessage, GuestStream};

use crate::{closed, message, next_frame, Socket, Streams};

pub(crate) async fn pump<S: AsyncRead + AsyncWrite + Unpin>(mut ws: Socket<S>, streams: &mut Streams<'_>) -> i32 {
    loop {
        let Some(frame) = next_frame(&mut ws).await else { return 1 };
        if let Some(code) = closed(&frame, streams).await {
            return code;
        }
        let Some(message) = message(&frame) else { continue };
        let Ok(read) = serde_json::from_value::<GuestCliMessage>(message.clone()) else { continue };
        match read {
            GuestCliMessage::Text { stream, text } => {
                let to: &mut (dyn AsyncWrite + Unpin + Send) = match stream {
                    GuestStream::Out => streams.out,
                    GuestStream::Err => streams.err,
                };
                if to.write_all(text.as_bytes()).await.is_err() || to.flush().await.is_err() {
                    return 1;
                }
            }
            // The line is over; the socket closing after this is the host's business, not a failure of ours.
            GuestCliMessage::Exit { exit } => {
                let _ = streams.out.flush().await;
                let _ = streams.err.flush().await;
                return exit;
            }
        }
    }
}
