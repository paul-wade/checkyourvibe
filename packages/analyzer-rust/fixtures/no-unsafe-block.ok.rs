fn read(ptr: *const i32) -> i32 {
    // SAFETY: ptr is valid and aligned by contract.
    unsafe { *ptr }
}
