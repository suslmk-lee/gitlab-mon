export namespace confluence {
	
	export class Page {
	    id: string;
	    title: string;
	    space_key: string;
	    space_name: string;
	    author: string;
	    // Go type: time
	    created: any;
	    // Go type: time
	    updated: any;
	    url: string;
	    products: string[];
	
	    static createFrom(source: any = {}) {
	        return new Page(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.space_key = source["space_key"];
	        this.space_name = source["space_name"];
	        this.author = source["author"];
	        this.created = this.convertValues(source["created"], null);
	        this.updated = this.convertValues(source["updated"], null);
	        this.url = source["url"];
	        this.products = source["products"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Space {
	    key: string;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new Space(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.name = source["name"];
	    }
	}

}

export namespace gitlab {
	
	export class Author {
	    id: number;
	    username: string;
	    name: string;
	    avatar_url: string;
	    is_bot: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Author(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.username = source["username"];
	        this.name = source["name"];
	        this.avatar_url = source["avatar_url"];
	        this.is_bot = source["is_bot"];
	    }
	}
	export class PushData {
	    commit_count: number;
	    action: string;
	    ref_type: string;
	    ref: string;
	    commit_title: string;
	
	    static createFrom(source: any = {}) {
	        return new PushData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.commit_count = source["commit_count"];
	        this.action = source["action"];
	        this.ref_type = source["ref_type"];
	        this.ref = source["ref"];
	        this.commit_title = source["commit_title"];
	    }
	}
	export class Event {
	    id: number;
	    project_id: number;
	    action_name: string;
	    target_type: string;
	    target_title: string;
	    target_iid: number;
	    author: Author;
	    push_data?: PushData;
	    // Go type: time
	    created_at: any;
	    project_path: string;
	    project_url: string;
	
	    static createFrom(source: any = {}) {
	        return new Event(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.project_id = source["project_id"];
	        this.action_name = source["action_name"];
	        this.target_type = source["target_type"];
	        this.target_title = source["target_title"];
	        this.target_iid = source["target_iid"];
	        this.author = this.convertValues(source["author"], Author);
	        this.push_data = this.convertValues(source["push_data"], PushData);
	        this.created_at = this.convertValues(source["created_at"], null);
	        this.project_path = source["project_path"];
	        this.project_url = source["project_url"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class MergeRequest {
	    id: number;
	    iid: number;
	    project_id: number;
	    title: string;
	    state: string;
	    draft: boolean;
	    author: Author;
	    source_branch: string;
	    target_branch: string;
	    web_url: string;
	    // Go type: time
	    created_at: any;
	    // Go type: time
	    updated_at: any;
	    // Go type: time
	    merged_at?: any;
	    project_path: string;
	    // Go type: time
	    first_review_at?: any;
	    first_reviewer: string;
	    approvers: string[];
	
	    static createFrom(source: any = {}) {
	        return new MergeRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.iid = source["iid"];
	        this.project_id = source["project_id"];
	        this.title = source["title"];
	        this.state = source["state"];
	        this.draft = source["draft"];
	        this.author = this.convertValues(source["author"], Author);
	        this.source_branch = source["source_branch"];
	        this.target_branch = source["target_branch"];
	        this.web_url = source["web_url"];
	        this.created_at = this.convertValues(source["created_at"], null);
	        this.updated_at = this.convertValues(source["updated_at"], null);
	        this.merged_at = this.convertValues(source["merged_at"], null);
	        this.project_path = source["project_path"];
	        this.first_review_at = this.convertValues(source["first_review_at"], null);
	        this.first_reviewer = source["first_reviewer"];
	        this.approvers = source["approvers"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Pipeline {
	    id: number;
	    project_id: number;
	    status: string;
	    source: string;
	    ref: string;
	    sha: string;
	    // Go type: time
	    created_at: any;
	    // Go type: time
	    updated_at: any;
	    web_url: string;
	    project_path: string;
	
	    static createFrom(source: any = {}) {
	        return new Pipeline(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.project_id = source["project_id"];
	        this.status = source["status"];
	        this.source = source["source"];
	        this.ref = source["ref"];
	        this.sha = source["sha"];
	        this.created_at = this.convertValues(source["created_at"], null);
	        this.updated_at = this.convertValues(source["updated_at"], null);
	        this.web_url = source["web_url"];
	        this.project_path = source["project_path"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Project {
	    id: number;
	    path_with_namespace: string;
	    name: string;
	    web_url: string;
	    // Go type: time
	    last_activity_at: any;
	
	    static createFrom(source: any = {}) {
	        return new Project(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.path_with_namespace = source["path_with_namespace"];
	        this.name = source["name"];
	        this.web_url = source["web_url"];
	        this.last_activity_at = this.convertValues(source["last_activity_at"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class Statistics {
	    forks: string;
	    issues: string;
	    merge_requests: string;
	    users: string;
	    projects: string;
	    groups: string;
	    active_users: string;
	
	    static createFrom(source: any = {}) {
	        return new Statistics(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.forks = source["forks"];
	        this.issues = source["issues"];
	        this.merge_requests = source["merge_requests"];
	        this.users = source["users"];
	        this.projects = source["projects"];
	        this.groups = source["groups"];
	        this.active_users = source["active_users"];
	    }
	}
	export class Version {
	    version: string;
	    revision: string;
	
	    static createFrom(source: any = {}) {
	        return new Version(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.revision = source["revision"];
	    }
	}

}

export namespace jira {
	
	export class Comment {
	    author: string;
	    // Go type: time
	    created: any;
	    // Go type: time
	    updated: any;
	    body_html: string;
	
	    static createFrom(source: any = {}) {
	        return new Comment(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.author = source["author"];
	        this.created = this.convertValues(source["created"], null);
	        this.updated = this.convertValues(source["updated"], null);
	        this.body_html = source["body_html"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Issue {
	    key: string;
	    summary: string;
	    parent_key: string;
	    parent_summary: string;
	    is_subtask: boolean;
	    project_key: string;
	    project_name: string;
	    status: string;
	    status_category: string;
	    assignee: string;
	    priority: string;
	    type: string;
	    // Go type: time
	    created: any;
	    // Go type: time
	    updated: any;
	    due_date: string;
	    resolved: boolean;
	    url: string;
	
	    static createFrom(source: any = {}) {
	        return new Issue(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.summary = source["summary"];
	        this.parent_key = source["parent_key"];
	        this.parent_summary = source["parent_summary"];
	        this.is_subtask = source["is_subtask"];
	        this.project_key = source["project_key"];
	        this.project_name = source["project_name"];
	        this.status = source["status"];
	        this.status_category = source["status_category"];
	        this.assignee = source["assignee"];
	        this.priority = source["priority"];
	        this.type = source["type"];
	        this.created = this.convertValues(source["created"], null);
	        this.updated = this.convertValues(source["updated"], null);
	        this.due_date = source["due_date"];
	        this.resolved = source["resolved"];
	        this.url = source["url"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Transition {
	    id: string;
	    name: string;
	    to_status: string;
	    to_category: string;
	
	    static createFrom(source: any = {}) {
	        return new Transition(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.to_status = source["to_status"];
	        this.to_category = source["to_category"];
	    }
	}

}

export namespace main {
	
	export class AliasEntry {
	    key: string;
	    username: string;
	
	    static createFrom(source: any = {}) {
	        return new AliasEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.username = source["username"];
	    }
	}
	export class GLUserLite {
	    username: string;
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new GLUserLite(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.username = source["username"];
	        this.name = source["name"];
	    }
	}
	export class UnmappedAuthor {
	    name: string;
	    email: string;
	    commits: number;
	
	    static createFrom(source: any = {}) {
	        return new UnmappedAuthor(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.email = source["email"];
	        this.commits = source["commits"];
	    }
	}
	export class AuthorMappingData {
	    aliases: AliasEntry[];
	    unmapped: UnmappedAuthor[];
	    users: GLUserLite[];
	
	    static createFrom(source: any = {}) {
	        return new AuthorMappingData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.aliases = this.convertValues(source["aliases"], AliasEntry);
	        this.unmapped = this.convertValues(source["unmapped"], UnmappedAuthor);
	        this.users = this.convertValues(source["users"], GLUserLite);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CodeDay {
	    user: string;
	    day: string;
	    add: number;
	    del: number;
	    commits: number;
	
	    static createFrom(source: any = {}) {
	        return new CodeDay(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.user = source["user"];
	        this.day = source["day"];
	        this.add = source["add"];
	        this.del = source["del"];
	        this.commits = source["commits"];
	    }
	}
	export class Entity {
	    id: string;
	    name: string;
	    kind: string;
	    gitlab_groups: string[];
	    jira_keys: string[];
	    confluence_query: string;
	    aliases: string[];
	    accent: string;
	    active: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Entity(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.kind = source["kind"];
	        this.gitlab_groups = source["gitlab_groups"];
	        this.jira_keys = source["jira_keys"];
	        this.confluence_query = source["confluence_query"];
	        this.aliases = source["aliases"];
	        this.accent = source["accent"];
	        this.active = source["active"];
	    }
	}
	
	export class JiraIssueDetail {
	    description: string;
	    transitions: jira.Transition[];
	    comments: jira.Comment[];
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new JiraIssueDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.description = source["description"];
	        this.transitions = this.convertValues(source["transitions"], jira.Transition);
	        this.comments = this.convertValues(source["comments"], jira.Comment);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Note {
	    id: number;
	    kind: string;
	    title: string;
	    occurred_at: string;
	    participants: string;
	    entity_ids: string[];
	    summary: string;
	    decisions: string;
	    action_items: string;
	    created_at: string;
	    updated_at: string;
	    confluence_id: string;
	    confluence_url: string;
	
	    static createFrom(source: any = {}) {
	        return new Note(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.kind = source["kind"];
	        this.title = source["title"];
	        this.occurred_at = source["occurred_at"];
	        this.participants = source["participants"];
	        this.entity_ids = source["entity_ids"];
	        this.summary = source["summary"];
	        this.decisions = source["decisions"];
	        this.action_items = source["action_items"];
	        this.created_at = source["created_at"];
	        this.updated_at = source["updated_at"];
	        this.confluence_id = source["confluence_id"];
	        this.confluence_url = source["confluence_url"];
	    }
	}
	export class NoteAI {
	    content: string;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new NoteAI(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.content = source["content"];
	        this.error = source["error"];
	    }
	}
	export class NoteResult {
	    note: Note;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new NoteResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.note = this.convertValues(source["note"], Note);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Snapshot {
	    // Go type: time
	    fetched_at: any;
	    gitlab_url: string;
	    version?: gitlab.Version;
	    stats?: gitlab.Statistics;
	    events: gitlab.Event[];
	    projects: gitlab.Project[];
	    open_mrs: gitlab.MergeRequest[];
	    merged_mrs: gitlab.MergeRequest[];
	    pipelines: gitlab.Pipeline[];
	    code_daily: CodeDay[];
	    jira_issues: jira.Issue[];
	    jira_url: string;
	    confluence_pages: confluence.Page[];
	    entities: Entity[];
	    error: string;
	    warning: string;
	    needs_config: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Snapshot(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.fetched_at = this.convertValues(source["fetched_at"], null);
	        this.gitlab_url = source["gitlab_url"];
	        this.version = this.convertValues(source["version"], gitlab.Version);
	        this.stats = this.convertValues(source["stats"], gitlab.Statistics);
	        this.events = this.convertValues(source["events"], gitlab.Event);
	        this.projects = this.convertValues(source["projects"], gitlab.Project);
	        this.open_mrs = this.convertValues(source["open_mrs"], gitlab.MergeRequest);
	        this.merged_mrs = this.convertValues(source["merged_mrs"], gitlab.MergeRequest);
	        this.pipelines = this.convertValues(source["pipelines"], gitlab.Pipeline);
	        this.code_daily = this.convertValues(source["code_daily"], CodeDay);
	        this.jira_issues = this.convertValues(source["jira_issues"], jira.Issue);
	        this.jira_url = source["jira_url"];
	        this.confluence_pages = this.convertValues(source["confluence_pages"], confluence.Page);
	        this.entities = this.convertValues(source["entities"], Entity);
	        this.error = source["error"];
	        this.warning = source["warning"];
	        this.needs_config = source["needs_config"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class WeekDay {
	    day: string;
	    commits: number;
	    add: number;
	    del: number;
	
	    static createFrom(source: any = {}) {
	        return new WeekDay(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.day = source["day"];
	        this.commits = source["commits"];
	        this.add = source["add"];
	        this.del = source["del"];
	    }
	}
	export class WeekProjectWork {
	    path: string;
	    web_url: string;
	    commit_count: number;
	    add: number;
	    del: number;
	    commit_msgs: string[];
	    merged_mrs: string[];
	    opened_mrs: string[];
	    branches: string[];
	
	    static createFrom(source: any = {}) {
	        return new WeekProjectWork(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.web_url = source["web_url"];
	        this.commit_count = source["commit_count"];
	        this.add = source["add"];
	        this.del = source["del"];
	        this.commit_msgs = source["commit_msgs"];
	        this.merged_mrs = source["merged_mrs"];
	        this.opened_mrs = source["opened_mrs"];
	        this.branches = source["branches"];
	    }
	}
	export class WeekReport {
	    username: string;
	    week_start: string;
	    week_end: string;
	    week_offset: number;
	    total_commits: number;
	    total_add: number;
	    total_del: number;
	    merged_count: number;
	    opened_count: number;
	    projects: WeekProjectWork[];
	    days: WeekDay[];
	    has_ai_key: boolean;
	    error: string;
	
	    static createFrom(source: any = {}) {
	        return new WeekReport(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.username = source["username"];
	        this.week_start = source["week_start"];
	        this.week_end = source["week_end"];
	        this.week_offset = source["week_offset"];
	        this.total_commits = source["total_commits"];
	        this.total_add = source["total_add"];
	        this.total_del = source["total_del"];
	        this.merged_count = source["merged_count"];
	        this.opened_count = source["opened_count"];
	        this.projects = this.convertValues(source["projects"], WeekProjectWork);
	        this.days = this.convertValues(source["days"], WeekDay);
	        this.has_ai_key = source["has_ai_key"];
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

