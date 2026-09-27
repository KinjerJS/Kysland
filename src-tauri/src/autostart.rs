//! Start with Windows through an "at log on" scheduled task: Windows delays the registry Run
//! key (over a minute when many programs start with the session), a task starts right away.
//! Creating it doesn't need admin rights.
use crate::util::hidden;
use std::fs;

const TASK: &str = "Kysland";

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

pub fn is_enabled() -> bool {
    hidden("schtasks.exe").args(["/Query", "/TN", TASK]).output().map(|o| o.status.success()).unwrap_or(false)
}

pub fn enable(exe: &str, args: &[String]) -> Result<(), String> {
    let user = format!("{}\\{}", std::env::var("USERDOMAIN").unwrap_or_default(), std::env::var("USERNAME").unwrap_or_default());
    let arg_line = args.iter().map(|a| format!("\"{a}\"")).collect::<Vec<_>>().join(" ");
    let arguments = if arg_line.is_empty() { String::new() } else { format!("<Arguments>{}</Arguments>", xml_escape(&arg_line)) };
    // Priority 4 is the "normal" class (7, the default, slows the UI down).
    let xml = format!(r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Starts Kysland when you sign in</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{u}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{u}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>4</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>{exe}</Command>{arguments}</Exec></Actions>
</Task>"#, u = xml_escape(&user), exe = xml_escape(exe));
    let file = std::env::temp_dir().join(format!("kysland-task-{}.xml", std::process::id()));
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(xml.encode_utf16().flat_map(|u| u.to_le_bytes()));
    fs::write(&file, bytes).map_err(|e| e.to_string())?;
    let out = hidden("schtasks.exe").args(["/Create", "/TN", TASK, "/XML"]).arg(&file).arg("/F").output();
    let _ = fs::remove_file(&file);
    match out {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_owned()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn disable() {
    let _ = hidden("schtasks.exe").args(["/Delete", "/TN", TASK, "/F"]).output();
}
