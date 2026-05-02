//! Version expression parser: `<2.17.0`, `>=1.0,<2.0`, `=4.5.6`, `!=1.2.3`.
//! Comma-separated clauses are AND-ed. Versions are compared component-wise
//! after splitting on `.` `-` `+`; numeric segments compare numerically and
//! beat string segments at the same depth.

use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
}

#[derive(Debug, Clone)]
pub struct Constraint {
    pub op: Op,
    pub version: String,
}

#[derive(Debug, Clone)]
pub struct VersionExpr {
    pub constraints: Vec<Constraint>,
}

impl VersionExpr {
    pub fn parse(input: &str) -> Result<Self, String> {
        let mut constraints = Vec::new();
        for clause in input.split(',') {
            let clause = clause.trim();
            if clause.is_empty() {
                continue;
            }
            let (op, rest) = parse_op(clause)?;
            let version = rest.trim().to_string();
            if version.is_empty() {
                return Err(format!("missing version after operator in '{}'", clause));
            }
            constraints.push(Constraint { op, version });
        }
        if constraints.is_empty() {
            return Err("empty version expression".to_string());
        }
        Ok(Self { constraints })
    }

    pub fn matches(&self, version: &str) -> bool {
        self.constraints
            .iter()
            .all(|c| compare(version, &c.version, c.op))
    }
}

fn parse_op(s: &str) -> Result<(Op, &str), String> {
    if let Some(rest) = s.strip_prefix("<=") {
        Ok((Op::Le, rest))
    } else if let Some(rest) = s.strip_prefix(">=") {
        Ok((Op::Ge, rest))
    } else if let Some(rest) = s.strip_prefix("!=") {
        Ok((Op::Ne, rest))
    } else if let Some(rest) = s.strip_prefix('<') {
        Ok((Op::Lt, rest))
    } else if let Some(rest) = s.strip_prefix('>') {
        Ok((Op::Gt, rest))
    } else if let Some(rest) = s.strip_prefix('=') {
        Ok((Op::Eq, rest))
    } else {
        Ok((Op::Eq, s))
    }
}

fn compare(actual: &str, expected: &str, op: Op) -> bool {
    let ord = compare_versions(actual, expected);
    match op {
        Op::Lt => ord == Ordering::Less,
        Op::Le => ord != Ordering::Greater,
        Op::Gt => ord == Ordering::Greater,
        Op::Ge => ord != Ordering::Less,
        Op::Eq => ord == Ordering::Equal,
        Op::Ne => ord != Ordering::Equal,
    }
}

fn compare_versions(a: &str, b: &str) -> Ordering {
    let a_parts = split(a);
    let b_parts = split(b);
    let len = a_parts.len().max(b_parts.len());
    for i in 0..len {
        let av = a_parts.get(i).copied().unwrap_or("0");
        let bv = b_parts.get(i).copied().unwrap_or("0");
        let ord = match (av.parse::<u64>(), bv.parse::<u64>()) {
            (Ok(an), Ok(bn)) => an.cmp(&bn),
            (Ok(_), Err(_)) => Ordering::Greater,
            (Err(_), Ok(_)) => Ordering::Less,
            (Err(_), Err(_)) => av.cmp(bv),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    Ordering::Equal
}

fn split(v: &str) -> Vec<&str> {
    v.split(['.', '-', '+']).filter(|s| !s.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_single_lt() {
        let e = VersionExpr::parse("<2.17.0").unwrap();
        assert!(e.matches("2.16.0"));
        assert!(!e.matches("2.17.0"));
        assert!(!e.matches("2.17.1"));
    }

    #[test]
    fn parse_compound_range() {
        let e = VersionExpr::parse(">=1.0.0,<2.0.0").unwrap();
        assert!(e.matches("1.5.3"));
        assert!(!e.matches("0.9.9"));
        assert!(!e.matches("2.0.0"));
    }

    #[test]
    fn parse_eq() {
        let e = VersionExpr::parse("=4.5.6").unwrap();
        assert!(e.matches("4.5.6"));
        assert!(!e.matches("4.5.7"));
    }

    #[test]
    fn parse_bare_version_is_eq() {
        let e = VersionExpr::parse("4.5.6").unwrap();
        assert!(e.matches("4.5.6"));
        assert!(!e.matches("4.5.7"));
    }

    #[test]
    fn parse_ne() {
        let e = VersionExpr::parse("!=1.2.3").unwrap();
        assert!(e.matches("1.2.4"));
        assert!(!e.matches("1.2.3"));
    }

    #[test]
    fn missing_version_errors() {
        assert!(VersionExpr::parse(">=").is_err());
        assert!(VersionExpr::parse("").is_err());
    }

    #[test]
    fn handles_uneven_segments() {
        let e = VersionExpr::parse("<2").unwrap();
        assert!(e.matches("1.99.99"));
        assert!(!e.matches("2.0.0"));
    }

    #[test]
    fn handles_os_package_suffix() {
        let e = VersionExpr::parse("<2.17.0").unwrap();
        assert!(e.matches("2.16.0-1ubuntu1.1"));
    }

    #[test]
    fn numeric_beats_prerelease() {
        assert_eq!(compare_versions("1.0.0", "1.0.0-rc1"), Ordering::Greater);
    }
}
