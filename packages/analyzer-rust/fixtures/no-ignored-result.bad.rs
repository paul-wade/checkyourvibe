fn may_fail() -> Result<i32, ()> {
    Ok(1)
}

fn caller() {
    let _ = may_fail();
}
