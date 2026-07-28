fn main() {
    if let Some(code) = draftmatter_lib::run_cli_if_requested() {
        std::process::exit(code);
    }
    draftmatter_lib::run();
}
