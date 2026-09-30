//! Kys, the island's eyes as a little pet. It gets hungry and bored while Kysland runs, and is fed
//! and entertained with items bought with credits, earned by playing with it (and by using the PC
//! with it around). The engine owns the state (~/.config/kysland/kys.json) and checks every gain
//! and purchase; the pages show it and ask for changes.
use crate::{config, hub, util};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Kys {
    pub credits: u32,
    /// Fullness and happiness, 0 to 100.
    pub food: f64,
    pub joy: f64,
    /// Food bought and not eaten yet.
    pub inventory: HashMap<String, u32>,
    /// Toys and things to wear, bought once.
    pub owned: Vec<String>,
    pub wearing: Option<String>,
    /// Local day ("2026-09-30") the counters below are for.
    pub day: String,
    /// Today's gains by source (each has a daily cap).
    pub earned: HashMap<String, u32>,
    /// Days in a row with Kysland running (for the daily bonus).
    pub streak: u32,
    /// Today's minutes with the mouse moving (a credit every 10).
    pub active_minutes: u32,
    pub played_at: i64,
}

impl Default for Kys {
    fn default() -> Self {
        Kys {
            credits: 20, food: 70.0, joy: 70.0, inventory: HashMap::new(), owned: vec![], wearing: None,
            day: String::new(), earned: HashMap::new(), streak: 0, active_minutes: 0, played_at: 0,
        }
    }
}

/// Ways to earn: (source, credits, happiness, times a day).
const SOURCES: &[(&str, u32, f64, u32)] = &[
    ("peek", 1, 0.0, 15),   // it peeks into the island
    ("catch", 5, 8.0, 10),  // caught while peeking (clicked before it flees)
    ("dizzy", 2, -3.0, 10), // made dizzy by circling it
    ("flight", 3, 2.0, 5),  // back from being thrown out of the island
    ("poke", 1, 2.0, 10),   // poked while roaming
    ("talk", 1, 2.0, 10),   // talked to nicely (its page)
    ("time", 1, 0.0, 30),   // every 10 minutes of use (the engine's own)
];

pub enum Kind { Food { food: f64, joy: f64 }, Toy, Wear }

/// The shop: (item, price, what it is).
const ITEMS: &[(&str, u32, Kind)] = &[
    ("cookie", 5, Kind::Food { food: 15.0, joy: 0.0 }),
    ("apple", 8, Kind::Food { food: 20.0, joy: 5.0 }),
    ("candy", 6, Kind::Food { food: 5.0, joy: 15.0 }),
    ("cake", 20, Kind::Food { food: 50.0, joy: 20.0 }),
    ("ball", 60, Kind::Toy),
    ("bow", 50, Kind::Wear),
    ("cap", 80, Kind::Wear),
    ("glasses", 120, Kind::Wear),
    ("crown", 200, Kind::Wear),
];

const PLAY_EVERY_MS: i64 = 5 * 60_000;

static STATE: Mutex<Option<Kys>> = Mutex::new(None);

fn file() -> std::path::PathBuf { config::config_dir().join("kys.json") }

fn with<R>(f: impl FnOnce(&mut Kys) -> R) -> R {
    let mut guard = STATE.lock().unwrap();
    let kys = guard.get_or_insert_with(|| {
        std::fs::read_to_string(file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    });
    f(kys)
}

fn save(kys: &Kys) {
    if let Ok(text) = serde_json::to_string_pretty(kys) { let _ = std::fs::write(file(), text); }
}

/// Local date and its number of days since 1970 (to tell "yesterday" apart for the streak).
fn today() -> (String, i64) {
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    let (y, m, d) = (t.wYear as i64, t.wMonth as i64, t.wDay as i64);
    // Days since 1970 (Howard Hinnant's algorithm).
    let (yy, mo) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + (153 * mo + 2) / 5 + d - 1;
    (format!("{y:04}-{m:02}-{d:02}"), era * 146_097 + doe - 719_468)
}

fn day_number(day: &str) -> Option<i64> {
    let mut parts = day.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    let (yy, mo) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    Some(era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * mo + 2) / 5 + d - 1 - 719_468)
}

/// A new day: counters reset, streak and daily bonus. Returns the bonus.
fn roll_day(kys: &mut Kys) -> Option<u32> {
    let (day, n) = today();
    if kys.day == day { return None; }
    let yesterday = day_number(&kys.day).is_some_and(|d| d == n - 1);
    kys.streak = if yesterday { kys.streak + 1 } else { 1 };
    kys.day = day;
    kys.earned.clear();
    kys.active_minutes = 0;
    let bonus = 10 + 2 * (kys.streak - 1).min(7);
    kys.credits += bonus;
    Some(bonus)
}

fn clamp(v: f64) -> f64 { v.clamp(0.0, 100.0) }

/// Everything the pages show, with the shop and the ways to earn (and today's progress).
pub fn state() -> Value {
    with(|kys| {
        roll_day(kys);
        let items: Vec<Value> = ITEMS.iter().map(|(id, price, kind)| match kind {
            Kind::Food { food, joy } => json!({ "id": id, "price": price, "kind": "food", "food": food, "joy": joy }),
            Kind::Toy => json!({ "id": id, "price": price, "kind": "toy" }),
            Kind::Wear => json!({ "id": id, "price": price, "kind": "wear" }),
        }).collect();
        let sources: Vec<Value> = SOURCES.iter().map(|(id, credits, _, cap)| json!({
            "id": id, "credits": credits, "cap": cap, "today": kys.earned.get(*id).copied().unwrap_or(0),
        })).collect();
        json!({
            "credits": kys.credits, "food": kys.food.round(), "joy": kys.joy.round(),
            "inventory": kys.inventory, "owned": kys.owned, "wearing": kys.wearing, "streak": kys.streak,
            "canPlay": kys.owned.iter().any(|o| o == "ball") && util::now_ms() - kys.played_at >= PLAY_EVERY_MS,
            "items": items, "sources": sources,
        })
    })
}

/// Tells every window, with what was just earned if anything.
fn broadcast(gain: Option<(u32, &str)>) {
    hub::emit("kys", json!({ "state": state(), "gain": gain.map(|(amount, source)| json!({ "amount": amount, "source": source })) }));
}

pub fn load() {
    let bonus = with(|kys| {
        let bonus = roll_day(kys);
        save(kys);
        bonus
    });
    if let Some(b) = bonus { broadcast(Some((b, "daily"))); }
}

/// Once a minute: it gets hungrier and a bit bored; using the PC with it around earns credits.
pub fn tick(active: bool) {
    let (bonus, time) = with(|kys| {
        let bonus = roll_day(kys);
        kys.food = clamp(kys.food - 0.1); // 6 an hour
        kys.joy = clamp(kys.joy - 0.07);
        let mut time = None;
        if active {
            kys.active_minutes += 1;
            if kys.active_minutes % 10 == 0 { time = earn_in(kys, "time"); }
        }
        save(kys);
        (bonus, time)
    });
    broadcast(bonus.map(|b| (b, "daily")).or(time.map(|c| (c, "time"))));
}

fn earn_in(kys: &mut Kys, source: &str) -> Option<u32> {
    let (_, credits, joy, cap) = SOURCES.iter().find(|s| s.0 == source)?;
    let count = kys.earned.entry(source.to_owned()).or_insert(0);
    kys.joy = clamp(kys.joy + joy);
    if *count >= *cap { return None; }
    *count += 1;
    kys.credits += credits;
    Some(*credits)
}

/// Something happened with Kys (the page says what): credits, within today's cap.
pub fn earn(source: &str) {
    if source == "time" { return; } // the engine's own
    let gain = with(|kys| {
        roll_day(kys);
        let gain = earn_in(kys, source);
        save(kys);
        gain
    });
    broadcast(gain.map(|c| (c, source)));
}

/// Talked to: a credit and a bit of joy, unless it was to be mean (its answer is grumpy).
pub fn talked(mood: &str) {
    if mood != "grumpy" { return earn("talk"); }
    with(|kys| {
        kys.joy = (kys.joy - 4.0).max(0.0);
        save(kys);
    });
    broadcast(None);
}

pub fn buy(item: &str) -> Result<(), String> {
    let (_, price, kind) = ITEMS.iter().find(|i| i.0 == item).ok_or("unknown item")?;
    with(|kys| -> Result<(), String> {
        if matches!(kind, Kind::Toy | Kind::Wear) && kys.owned.iter().any(|o| o == item) { return Err("already owned".into()); }
        if kys.credits < *price { return Err("not enough credits".into()); }
        kys.credits -= price;
        match kind {
            Kind::Food { .. } => *kys.inventory.entry(item.to_owned()).or_insert(0) += 1,
            _ => kys.owned.push(item.to_owned()),
        }
        save(kys);
        Ok(())
    })?;
    broadcast(None);
    Ok(())
}

/// Feeds it something from the inventory; the island shows it eating.
pub fn feed(item: &str) -> Result<(), String> {
    let Some((_, _, Kind::Food { food, joy })) = ITEMS.iter().find(|i| i.0 == item) else { return Err("not food".into()) };
    with(|kys| {
        let left = kys.inventory.get_mut(item).filter(|n| **n > 0).ok_or("none left")?;
        *left -= 1;
        kys.food = clamp(kys.food + food);
        kys.joy = clamp(kys.joy + joy + 3.0);
        save(kys);
        Ok::<(), String>(())
    })?;
    hub::emit("kys-feed", json!({ "item": item }));
    broadcast(None);
    Ok(())
}

pub fn wear(item: Option<&str>) -> Result<(), String> {
    with(|kys| -> Result<(), String> {
        if let Some(i) = item {
            if !kys.owned.iter().any(|o| o == i) || !ITEMS.iter().any(|t| t.0 == i && matches!(t.2, Kind::Wear)) {
                return Err("not owned".into());
            }
        }
        kys.wearing = item.map(str::to_owned);
        save(kys);
        Ok(())
    })?;
    broadcast(None);
    Ok(())
}

/// Plays with the ball (every 5 minutes at most): a lot happier.
pub fn play() -> Result<(), String> {
    with(|kys| -> Result<(), String> {
        if !kys.owned.iter().any(|o| o == "ball") { return Err("no ball".into()); }
        let now = util::now_ms();
        if now - kys.played_at < PLAY_EVERY_MS { return Err("tired".into()); }
        kys.played_at = now;
        kys.joy = clamp(kys.joy + 20.0);
        kys.food = clamp(kys.food - 3.0);
        save(kys);
        Ok(())
    })?;
    hub::emit("kys-play", Value::Null);
    broadcast(None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn earnings_are_capped_per_day() {
        let mut k = Kys::default();
        for _ in 0..20 { earn_in(&mut k, "peek"); }
        assert_eq!(k.earned["peek"], 15);
        assert_eq!(k.credits, 20 + 15);
        assert_eq!(earn_in(&mut k, "catch"), Some(5));
        assert!(earn_in(&mut k, "made-up").is_none());
    }

    #[test]
    fn a_new_day_resets_the_counters_and_pays_the_bonus() {
        let mut k = Kys { day: "2000-01-01".into(), streak: 5, ..Kys::default() };
        k.earned.insert("peek".into(), 15);
        assert_eq!(roll_day(&mut k), Some(10)); // not yesterday: the streak starts over
        assert_eq!(k.streak, 1);
        assert!(k.earned.is_empty());
        assert_eq!(roll_day(&mut k), None); // same day
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2000-03-01"), Some(11_017));
        assert_eq!(day_number(&today().0), Some(today().1));
    }
}
