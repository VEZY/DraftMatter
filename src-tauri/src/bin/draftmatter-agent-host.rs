fn main() {
    let mut arguments = std::env::args().skip(1);
    let mut project_root = None;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--project-root" => project_root = arguments.next(),
            "--help" | "-h" => {
                println!("Usage: draftmatter-agent-host --project-root <path>");
                return;
            }
            _ => {
                eprintln!("Unknown option: {argument}");
                std::process::exit(64);
            }
        }
    }
    let Some(project_root) = project_root else {
        eprintln!("The execution host requires --project-root <path>.");
        std::process::exit(64);
    };
    if let Err(error) = draftmatter_lib::run_agent_host(&project_root) {
        eprintln!("DraftMatter execution host failed: {error}");
        std::process::exit(70);
    }
}
