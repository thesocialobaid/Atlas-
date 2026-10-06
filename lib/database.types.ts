// Generated from the live schema by Supabase. Regenerate after each migration.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      analyses: {
        Row: {
          adapter: string | null
          commit_sha: string | null
          coverage: Json | null
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          links_skipped: number | null
          org_id: string
          parser_version: number | null
          project_id: string
          stage: string | null
          status: string
        }
        Insert: {
          adapter?: string | null
          commit_sha?: string | null
          coverage?: Json | null
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          links_skipped?: number | null
          org_id: string
          parser_version?: number | null
          project_id: string
          stage?: string | null
          status?: string
        }
        Update: {
          adapter?: string | null
          commit_sha?: string | null
          coverage?: Json | null
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          links_skipped?: number | null
          org_id?: string
          parser_version?: number | null
          project_id?: string
          stage?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "analyses_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analyses_project_id_org_id_fkey"
            columns: ["project_id", "org_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      edges: {
        Row: {
          analysis_id: string
          from_file_id: string
          id: string
          kind: string
          org_id: string
          to_file_id: string
        }
        Insert: {
          analysis_id: string
          from_file_id: string
          id?: string
          kind: string
          org_id: string
          to_file_id: string
        }
        Update: {
          analysis_id?: string
          from_file_id?: string
          id?: string
          kind?: string
          org_id?: string
          to_file_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "edges_analysis_id_org_id_fkey"
            columns: ["analysis_id", "org_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "edges_from_file_id_org_id_fkey"
            columns: ["from_file_id", "org_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "edges_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edges_to_file_id_org_id_fkey"
            columns: ["to_file_id", "org_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id", "org_id"]
          },
        ]
      }
      explanations: {
        Row: {
          body: string
          created_at: string
          file_id: string
          id: string
          org_id: string
        }
        Insert: {
          body: string
          created_at?: string
          file_id: string
          id?: string
          org_id: string
        }
        Update: {
          body?: string
          created_at?: string
          file_id?: string
          id?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "explanations_file_id_org_id_fkey"
            columns: ["file_id", "org_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "explanations_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      file_roles: {
        Row: {
          file_id: string
          id: string
          org_id: string
          role: string
          source: string
        }
        Insert: {
          file_id: string
          id?: string
          org_id: string
          role: string
          source: string
        }
        Update: {
          file_id?: string
          id?: string
          org_id?: string
          role?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "file_roles_file_id_org_id_fkey"
            columns: ["file_id", "org_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "file_roles_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      files: {
        Row: {
          analysis_id: string
          bytes: number
          folder: string
          had_syntax_errors: boolean | null
          id: string
          language: string
          lines: number | null
          module: string | null
          org_id: string
          path: string
          sha256: string
          skip_reason: string | null
          status: string
        }
        Insert: {
          analysis_id: string
          bytes: number
          folder: string
          had_syntax_errors?: boolean | null
          id?: string
          language: string
          lines?: number | null
          module?: string | null
          org_id: string
          path: string
          sha256: string
          skip_reason?: string | null
          status: string
        }
        Update: {
          analysis_id?: string
          bytes?: number
          folder?: string
          had_syntax_errors?: boolean | null
          id?: string
          language?: string
          lines?: number | null
          module?: string | null
          org_id?: string
          path?: string
          sha256?: string
          skip_reason?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "files_analysis_id_org_id_fkey"
            columns: ["analysis_id", "org_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "files_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      imports: {
        Row: {
          analysis_id: string
          from_file_id: string
          id: string
          kind: string
          line: number
          org_id: string
          outcome: string
          reason: string
          specifier: string
        }
        Insert: {
          analysis_id: string
          from_file_id: string
          id?: string
          kind: string
          line: number
          org_id: string
          outcome: string
          reason: string
          specifier: string
        }
        Update: {
          analysis_id?: string
          from_file_id?: string
          id?: string
          kind?: string
          line?: number
          org_id?: string
          outcome?: string
          reason?: string
          specifier?: string
        }
        Relationships: [
          {
            foreignKeyName: "imports_analysis_id_org_id_fkey"
            columns: ["analysis_id", "org_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "imports_from_file_id_org_id_fkey"
            columns: ["from_file_id", "org_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "imports_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      insights: {
        Row: {
          analysis_id: string
          body: string
          created_at: string
          id: string
          org_id: string
        }
        Insert: {
          analysis_id: string
          body: string
          created_at?: string
          id?: string
          org_id: string
        }
        Update: {
          analysis_id?: string
          body?: string
          created_at?: string
          id?: string
          org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "insights_analysis_id_org_id_fkey"
            columns: ["analysis_id", "org_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "insights_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
        }
        Insert: {
          created_at?: string
          id: string
        }
        Update: {
          created_at?: string
          id?: string
        }
        Relationships: []
      }
      projects: {
        Row: {
          created_at: string
          id: string
          org_id: string
          repo_name: string
          repo_owner: string
        }
        Insert: {
          created_at?: string
          id?: string
          org_id: string
          repo_name: string
          repo_owner: string
        }
        Update: {
          created_at?: string
          id?: string
          org_id?: string
          repo_name?: string
          repo_owner?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      routes: {
        Row: {
          file_id: string
          id: string
          method: string
          org_id: string
          path: string
        }
        Insert: {
          file_id: string
          id?: string
          method: string
          org_id: string
          path: string
        }
        Update: {
          file_id?: string
          id?: string
          method?: string
          org_id?: string
          path?: string
        }
        Relationships: [
          {
            foreignKeyName: "routes_file_id_org_id_fkey"
            columns: ["file_id", "org_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id", "org_id"]
          },
          {
            foreignKeyName: "routes_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
