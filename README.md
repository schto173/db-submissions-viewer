# DB submissions viewer

Check student database submissions from Moodle (Modelizer MCD / MLD / EMLD + SQL dump)
against a model solution and the CNES *Naming Conventions for Database Modeling*.

**Open it:** https://schto173.github.io/db-submissions-viewer/
(or download this repository as ZIP, unpack it, and double-click `index.html`).
Nothing to install. It works in a current Chrome, Edge or Firefox.

## How to use

1. In Moodle, open the assignment → **View all submissions** → **Download all submissions**.
2. Drop that zip onto the page (or click **Import zip**).
3. Click through the students (**J / K** = next / previous).

Each student has these tabs:

- **Review:** findings, plus a rule-by-rule naming scorecard.
- **Diagram:** MCD / MLD / EMLD with the problems highlighted, optionally next to the model solution.
- **SQL:** the dump with findings marked on the lines.
- **Tables & data:** the tables and the inserted sample data.
- **Documents:** the PDFs.

Switch all findings off and on with the **Findings** switch in the top bar (or **F**).

## Check a single submission

On the start page choose **One submission: single files** (or **＋ Check one submission**
on the overview). Add the Modelizer file (`.json` / `.mdlz`), the `.sql` dump and the PDF,
all at once or one by one with **＋ Add files** or drag & drop. A file with the same name
replaces the old one, and **Files → Remove** takes one out again. A zip with one student's
files (not a Moodle export) also works. Students can use this to check their own work
before handing it in.

## Your own assignment

The repository comes with the model solution and user story of the
*L1 – Datenbank (charging stations)* assignment. For another assignment, use
**Solution → Use my own model solution…** (a Modelizer `.mdlz`/`.json`) and
**User story → Use my own PDF…**. Additions beyond the model solution are never reported.

## Privacy

Zips and files are opened **inside your browser** and stored only there (IndexedDB).
Nothing is uploaded, not even when you use the GitHub Pages link. **🗑 Remove** deletes an import again.
