//! Credential replies must finish writing before the helper process exits.

use std::io;
use std::os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};

use windows_sys::Win32::Foundation::{
    ERROR_INVALID_HANDLE, ERROR_IO_PENDING, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{GetFileType, WriteFile, FILE_TYPE_PIPE};
use windows_sys::Win32::System::Console::{GetStdHandle, STD_OUTPUT_HANDLE};
use windows_sys::Win32::System::Threading::CreateEventW;
use windows_sys::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
use zeroize::Zeroizing;

pub(super) fn write_stdout(answer: &str) -> io::Result<bool> {
    // GetStdHandle returns a borrowed process handle, not a new owned handle.
    let raw = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::from_raw_os_error(ERROR_INVALID_HANDLE as i32));
    }
    // The helper owns no concurrent stdout replacement or writes.
    let output = unsafe { BorrowedHandle::borrow_raw(raw) };
    if unsafe { GetFileType(raw) } != FILE_TYPE_PIPE {
        return Ok(false);
    }
    let message = Zeroizing::new(format!("{answer}\n"));
    write_pipe(output, message.as_bytes())?;
    Ok(true)
}

fn completion_event() -> io::Result<OwnedHandle> {
    let raw_event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
    if raw_event.is_null() {
        return Err(io::Error::last_os_error());
    }
    // CreateEventW returned an owned, non-inheritable event.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw_event) })
}

fn write_pipe(output: BorrowedHandle<'_>, mut bytes: &[u8]) -> io::Result<()> {
    // OpenSSH can pass overlapped pipe handles. A private event identifies this
    // write's completion instead of relying on the shared pipe handle's state.
    let event = completion_event()?;
    while !bytes.is_empty() {
        let mut operation = OVERLAPPED {
            hEvent: event.as_raw_handle(),
            ..OVERLAPPED::default()
        };
        let count = bytes.len().min(u32::MAX as usize) as u32;
        // The buffer, event and OVERLAPPED remain alive until completion below.
        let started = unsafe {
            WriteFile(
                output.as_raw_handle(),
                bytes.as_ptr(),
                count,
                std::ptr::null_mut(),
                &mut operation,
            )
        };
        if started == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
                return Err(error);
            }
        }
        let mut written = 0;
        // Also retrieve the final byte count when WriteFile completed immediately.
        if unsafe {
            GetOverlappedResult(
                output.as_raw_handle(),
                std::ptr::addr_of!(operation),
                &mut written,
                1,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if written == 0 {
            return Err(io::Error::from(io::ErrorKind::WriteZero));
        }
        bytes = &bytes[written as usize..];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Read;
    use std::os::windows::io::AsHandle;
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{ERROR_PIPE_CONNECTED, GENERIC_READ};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
        PIPE_ACCESS_OUTBOUND,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, CreatePipe, PIPE_TYPE_BYTE, PIPE_WAIT,
    };

    fn pipe(overlapped: bool) -> (File, OwnedHandle) {
        if !overlapped {
            let (mut read, mut write) = (std::ptr::null_mut(), std::ptr::null_mut());
            assert_ne!(
                unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 128) },
                0
            );
            // CreatePipe returned two distinct owned handles.
            return unsafe {
                (
                    File::from_raw_handle(read),
                    OwnedHandle::from_raw_handle(write),
                )
            };
        }
        let name: Vec<u16> = format!(r"\\.\pipe\rebaseraven-credential-{}", uuid::Uuid::new_v4())
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let raw = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                PIPE_ACCESS_OUTBOUND | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_WAIT,
                1,
                128,
                128,
                0,
                std::ptr::null(),
            )
        };
        assert_ne!(raw, INVALID_HANDLE_VALUE);
        // CreateNamedPipeW returned a new owned server handle.
        let write = unsafe { OwnedHandle::from_raw_handle(raw) };
        let raw_read = unsafe {
            CreateFileW(
                name.as_ptr(),
                GENERIC_READ,
                0,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        assert_ne!(raw_read, INVALID_HANDLE_VALUE);
        // CreateFileW connected a new, synchronous reader to this private pipe.
        let read = unsafe { File::from_raw_handle(raw_read) };
        let event = completion_event().unwrap();
        let mut operation = OVERLAPPED {
            hEvent: event.as_raw_handle(),
            ..OVERLAPPED::default()
        };
        if unsafe { ConnectNamedPipe(write.as_raw_handle(), &mut operation) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_IO_PENDING as i32) {
                let mut transferred = 0;
                // Drain a pending connect before its event and storage leave scope.
                assert_ne!(
                    unsafe {
                        GetOverlappedResult(
                            write.as_raw_handle(),
                            std::ptr::addr_of!(operation),
                            &mut transferred,
                            1,
                        )
                    },
                    0
                );
            } else {
                assert_eq!(error.raw_os_error(), Some(ERROR_PIPE_CONNECTED as i32));
            }
        }
        (read, write)
    }

    #[test]
    fn replies_complete_on_synchronous_and_overlapped_pipes_with_a_slow_reader() {
        for overlapped in [false, true] {
            let (mut read, write) = pipe(overlapped);
            let message = "credential caf\u{e9} response\n".repeat(8192).into_bytes();
            let expected = message.clone();
            let reader = thread::spawn(move || {
                thread::sleep(Duration::from_millis(20));
                let mut received = Vec::new();
                let mut buffer = [0; 37];
                loop {
                    let count = read.read(&mut buffer).unwrap();
                    if count == 0 {
                        break;
                    }
                    received.extend_from_slice(&buffer[..count]);
                }
                received
            });
            write_pipe(write.as_handle(), &message).unwrap();
            drop(write);
            assert_eq!(reader.join().unwrap(), expected);
        }
    }

    #[test]
    fn a_closed_reader_is_an_error_instead_of_a_successful_empty_reply() {
        for overlapped in [false, true] {
            let (read, write) = pipe(overlapped);
            drop(read);
            assert!(write_pipe(write.as_handle(), b"credential response\n").is_err());
        }
    }
}
