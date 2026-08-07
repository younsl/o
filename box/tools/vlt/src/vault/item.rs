use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Link {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub links: Vec<Link>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ItemSummary {
    pub id: String,
    pub title: String,
    pub username: String,
    pub url: String,
    pub group: String,
    pub updated_at: DateTime<Utc>,
}

impl From<&Item> for ItemSummary {
    fn from(i: &Item) -> Self {
        Self {
            id: i.id.clone(),
            title: i.title.clone(),
            username: i.username.clone(),
            url: i.url.clone(),
            group: i.group.clone(),
            updated_at: i.updated_at,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewItem {
    pub title: String,
    #[serde(default)]
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub links: Vec<Link>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateItem {
    pub title: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub url: Option<String>,
    pub notes: Option<String>,
    pub group: Option<String>,
    pub links: Option<Vec<Link>>,
}

impl Item {
    pub fn from_new(input: NewItem) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            title: input.title,
            username: input.username,
            password: input.password,
            url: input.url,
            notes: input.notes,
            group: input.group.trim().to_string(),
            links: input.links,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn apply_update(&mut self, u: UpdateItem) {
        if let Some(v) = u.title {
            self.title = v;
        }
        if let Some(v) = u.username {
            self.username = v;
        }
        if let Some(v) = u.password {
            self.password = v;
        }
        if let Some(v) = u.url {
            self.url = v;
        }
        if let Some(v) = u.notes {
            self.notes = v;
        }
        if let Some(v) = u.group {
            self.group = v.trim().to_string();
        }
        if let Some(v) = u.links {
            self.links = v;
        }
        self.updated_at = Utc::now();
    }
}
