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

export namespace main {
	
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

}

