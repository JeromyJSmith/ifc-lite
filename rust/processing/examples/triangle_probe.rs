// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `triangle_probe` — per-element triangle-count attribution for a
//! total_triangles discrepancy (#2388).
//!
//! Runs the full native meshing pipeline (`process_geometry_filtered_with_quality`,
//! local-frame forced ON to match the wasm default, same as the determinism
//! harness) over one IFC file N times at a chosen tessellation tier, and:
//!
//! - prints per-run totals (meshes / triangles / vertices / CSG failures);
//! - diffs every run against run 0 at per-express-id granularity, printing the
//!   exact elements that moved if two in-process runs ever disagree;
//! - optionally dumps run 0's per-element counts (`--dump out.tsv`) and diffs
//!   run 0 against a previous dump (`--baseline other.tsv`), so two tiers, two
//!   commits, or two machines can be compared element-by-element.
//!
//! ```text
//! # run-to-run determinism, N=20:
//! cargo run --release -p ifc-lite-processing --example triangle_probe -- \
//!     tests/models/ara3d/schependomlaan.ifc --runs 20
//!
//! # attribute a delta between two tessellation tiers per element:
//! cargo run --release -p ifc-lite-processing --example triangle_probe -- \
//!     model.ifc --quality medium --dump /tmp/medium.tsv
//! cargo run --release -p ifc-lite-processing --example triangle_probe -- \
//!     model.ifc --quality low --baseline /tmp/medium.tsv
//! ```
//!
//! This is a diagnosis harness, not a regression gate: the committed gates are
//! `rust/processing/tests/mesh_determinism.rs` and its manifest pair.

use std::collections::BTreeMap;
use std::io::Write;

use ifc_lite_geometry::TessellationQuality;
use ifc_lite_processing::{process_geometry_filtered_with_quality, OpeningFilterMode};

/// Per-express-id (triangles, vertices), summed across that element's meshes.
type PerElement = BTreeMap<u32, (usize, usize)>;

fn diff(label: &str, base: &PerElement, other: &PerElement) {
    let mut delta = 0isize;
    for (id, bv) in base {
        match other.get(id) {
            Some(v) if v == bv => {}
            Some(v) => {
                println!("    #{id}: tris {} -> {}, verts {} -> {}", bv.0, v.0, bv.1, v.1);
                delta += v.0 as isize - bv.0 as isize;
            }
            None => println!("    #{id}: present in {label}, absent now"),
        }
    }
    for (id, v) in other.iter().filter(|(id, _)| !base.contains_key(id)) {
        println!("    #{id}: absent in {label}, present now (tris {})", v.0);
        delta += v.0 as isize;
    }
    println!("    triangle delta vs {label}: {delta:+}");
}

fn load_tsv(path: &str) -> PerElement {
    let mut per = PerElement::new();
    for line in std::fs::read_to_string(path).expect("read baseline tsv").lines() {
        let mut cols = line.split('\t');
        let id = cols.next().and_then(|c| c.parse().ok()).expect("baseline id column");
        let t = cols.next().and_then(|c| c.parse().ok()).expect("baseline triangle column");
        let v = cols.next().and_then(|c| c.parse().ok()).expect("baseline vertex column");
        per.insert(id, (t, v));
    }
    per
}

fn main() {
    let mut path = None;
    let mut runs = 1usize;
    let mut quality = TessellationQuality::Medium;
    let mut dump: Option<String> = None;
    let mut baseline_path: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--runs" => runs = args.next().expect("--runs N").parse().expect("--runs N"),
            "--quality" => {
                quality = match args.next().expect("--quality tier").as_str() {
                    "lowest" => TessellationQuality::Lowest,
                    "low" => TessellationQuality::Low,
                    "medium" => TessellationQuality::Medium,
                    "high" => TessellationQuality::High,
                    "highest" => TessellationQuality::Highest,
                    q => panic!("unknown quality {q} (lowest|low|medium|high|highest)"),
                }
            }
            "--dump" => dump = Some(args.next().expect("--dump out.tsv")),
            "--baseline" => baseline_path = Some(args.next().expect("--baseline other.tsv")),
            other => path = Some(other.to_string()),
        }
    }
    let path = path.expect(
        "usage: triangle_probe <file.ifc> [--runs N] [--quality tier] \
         [--dump out.tsv] [--baseline other.tsv]",
    );
    assert!(runs >= 1, "--runs must be >= 1 (got {runs})");
    let bytes = std::fs::read(&path).expect("read ifc");

    // Equalize with the wasm/browser default, same as the determinism harness.
    ifc_lite_geometry::local_frame_set_enabled_override(Some(true));

    let mut run0: Option<PerElement> = None;
    for run in 0..runs {
        let result =
            process_geometry_filtered_with_quality(&bytes, OpeningFilterMode::Default, quality);
        let mut per = PerElement::new();
        let mut tris = 0usize;
        let mut verts = 0usize;
        for m in &result.meshes {
            let t = m.indices.len() / 3;
            let v = m.positions.len() / 3;
            tris += t;
            verts += v;
            let e = per.entry(m.express_id).or_insert((0, 0));
            e.0 += t;
            e.1 += v;
        }
        println!(
            "run={run} quality={quality:?} meshes={} total_triangles={tris} \
             total_vertices={verts} csg_failures={}",
            result.meshes.len(),
            result.stats.total_csg_failures,
        );
        match &run0 {
            None => {
                if let Some(out) = &dump {
                    let mut f = std::fs::File::create(out).expect("create dump");
                    for (id, (t, v)) in &per {
                        writeln!(f, "{id}\t{t}\t{v}").expect("write dump");
                    }
                }
                if let Some(bp) = &baseline_path {
                    println!("  diff vs baseline {bp}:");
                    diff("baseline", &load_tsv(bp), &per);
                }
                run0 = Some(per);
            }
            Some(base) => {
                if *base != per {
                    println!("  NONDETERMINISM — this run differs from run 0:");
                    diff("run 0", base, &per);
                }
            }
        }
    }
}
