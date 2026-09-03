fn impossible(x: Option<i32>) -> i32 {
    match x {
        Some(n) => n,
        None => unreachable!(),
    }
}

#[test]
fn expected_failure() {
    panic!("test-only assertion");
}
