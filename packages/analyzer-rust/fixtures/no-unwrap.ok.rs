#[cfg(test)]
mod tests {
    fn helper() -> Option<String> {
        Some("value".to_string())
    }

    fn it_works() {
        helper().unwrap();
    }
}
