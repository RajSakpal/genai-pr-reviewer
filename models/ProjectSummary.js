import { DataTypes } from 'sequelize';
import sequelize from '../config/sequelize.js';

const ProjectSummary = sequelize.define('ProjectSummary', {
  repoName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  branchName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  summaryText: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  }
}, {
  tableName: 'project_summaries',
  timestamps: false,
});

export default ProjectSummary;
